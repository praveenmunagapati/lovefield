/**
 * @license
 * Copyright 2014 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
goog.provide('lf.cache.Journal');

goog.require('goog.array');
goog.require('goog.asserts');
goog.require('goog.structs.Map');
goog.require('goog.structs.Set');
goog.require('lf.Exception');
goog.require('lf.Global');
goog.require('lf.cache.TableDiff');
goog.require('lf.service');

goog.forwardDeclare('lf.cache.Cache');
goog.forwardDeclare('lf.index.Index');
goog.forwardDeclare('lf.index.IndexStore');
goog.forwardDeclare('lf.schema.Index');



/**
 * Transaction Journal which is contained within lf.backstore.Tx. The journal
 * stores rows changed by this transaction so that they can be merged into the
 * backing store. Caches and indices are updated as soon as a change is
 * recorded in the journal.
 * @constructor
 * @struct
 * @final
 *
 * @param {!Array.<!lf.schema.Table>} scope A list of tables that this journal
 *     should allow access. Trying to access any table not in that list will
 *     result in an error.
 */
lf.cache.Journal = function(scope) {
  /**
   * Scope of this transaction in the form of table schema.
   * @private {!goog.structs.Map.<string, !lf.schema.Table>}
   */
  this.scope_ = new goog.structs.Map();
  scope.forEach(function(tableSchema) {
    this.scope_.set(tableSchema.getName(), tableSchema);
  }, this);

  /** @private {!lf.cache.Cache} */
  this.cache_ = lf.Global.get().getService(lf.service.CACHE);

  /** @private {!lf.index.IndexStore} */
  this.indexStore_ = lf.Global.get().getService(lf.service.INDEX_STORE);

  /**
   * A terminated journal can no longer be modified or rolled back. This should
   * be set to true only after the changes in this Journal have been reflected
   * in the backing store, or the journal has been rolled back.
   * @private {boolean}
   */
  this.terminated_ = false;

  /**
   * The changes that have been applied since the start of this journal. The
   * keys are table names, and the values are changes that have happened per
   * table.
   * @private {!goog.structs.Map.<string, !lf.cache.TableDiff>}
   */
  this.tableDiffs_ = new goog.structs.Map();
};


/**
 * @return {!goog.structs.Map.<string, !lf.cache.TableDiff>}
 */
lf.cache.Journal.prototype.getDiff = function() {
  return this.tableDiffs_;
};


/**
 * @return {!goog.structs.Map.<string, !lf.schema.Table>}
 */
lf.cache.Journal.prototype.getScope = function() {
  return this.scope_;
};


/**
 * Finds the rowIds corresponding to records within the given key ranges.
 * @param {!lf.schema.Index} indexSchema
 * @param {!Array.<!lf.index.KeyRange>} keyRanges
 * @return {!Array.<number>}
 */
lf.cache.Journal.prototype.getIndexRange = function(
    indexSchema, keyRanges) {
  var rowIds = new goog.structs.Set();
  var index = this.indexStore_.get(indexSchema.getNormalizedName());

  // Getting rowIds within the given key ranges according to IndexStore.
  keyRanges.forEach(function(keyRange) {
    rowIds.addAll(index.getRange(keyRange));
  }, this);

  return rowIds.getValues();
};


/**
 * @param {string} tableName
 * @param {!Array.<number>=} opt_rowIds
 * @return {!Array.<?lf.Row>} Snapshot of rows of the table in this transaction.
 */
lf.cache.Journal.prototype.getTableRows = function(tableName, opt_rowIds) {
  var rowIds = goog.isDefAndNotNull(opt_rowIds) ?
      opt_rowIds : this.indexStore_.getRowIdIndex(tableName).getRange();
  return this.cache_.get(rowIds);
};


/**
 * @param {!lf.schema.Table} table
 * @param {!Array.<!lf.Row>} rows
 */
lf.cache.Journal.prototype.insert = function(table, rows) {
  this.checkScope_(table);
  this.checkPrimaryKeysUnique_(table, rows);
  this.checkPrimaryKeyExistence_(table, rows);

  var diff = new lf.cache.TableDiff();
  rows.forEach(function(row) {
    diff.add(row);
  });

  this.applyTableDiff_(table, diff);
};


/**
 * Checks whether any of the given rows already exists in the backstore, or in
 * this journal.
 * @param {!lf.schema.Table} table
 * @param {!Array.<!lf.Row>} rows
 * @private
 */
lf.cache.Journal.prototype.checkPrimaryKeyExistence_ = function(table, rows) {
  var pkIndexSchema = table.getConstraint().getPrimaryKey();
  if (goog.isNull(pkIndexSchema)) {
    // There is no primary key for the given table, nothing to check.
    return;
  }

  var existingPrimaryKey = null;
  var primaryKeyAlreadyExists = rows.some(
      function(row) {
        var existingRowId = this.findExistingRowIdInPkIndex_(table, row);
        if (!goog.isNull(existingRowId)) {
          existingPrimaryKey = row.keyOfIndex(
              pkIndexSchema.getNormalizedName());
          return true;
        }

        return false;
      }, this);

  if (primaryKeyAlreadyExists) {
    throw new lf.Exception(
        lf.Exception.Type.CONSTRAINT,
        'A row with primary key ' + existingPrimaryKey + ' already exists ' +
        ' in table ' + table.getName());
  }
};


/**
 * Checks that the primary keys in the given set of rows are unique.
 * @param {!lf.schema.Table} table
 * @param {!Array.<!lf.Row>} rows
 * @private
 */
lf.cache.Journal.prototype.checkPrimaryKeysUnique_ = function(table, rows) {
  var pkIndexSchema = table.getConstraint().getPrimaryKey();
  if (goog.isNull(pkIndexSchema)) {
    // There is no primary key for the given table, nothing to check.
    return;
  }

  var primaryKeys = new goog.structs.Set();
  rows.forEach(function(row) {
    var primaryKey = row.keyOfIndex(pkIndexSchema.getNormalizedName());
    primaryKeys.add(primaryKey);
  });

  if (primaryKeys.getCount() < rows.length) {
    throw new lf.Exception(
        lf.Exception.Type.CONSTRAINT,
        'Primary key violation when inserting rows to ' +
        table.getName());
  }
};


/**
 * Checks if any primary key violation occurs as a result of updating the given
 * set of rows.
 * @param {!lf.schema.Table} table
 * @param {!Array.<!lf.Row>} rows
 * @private
 */
lf.cache.Journal.prototype.checkPrimaryKeyUpdate_ = function(table, rows) {
  var primaryKeyModified = rows.some(function(updatedRow) {
    var existingRowId = this.findExistingRowIdInPkIndex_(table, updatedRow);
    return existingRowId != updatedRow.id();
  }, this);

  if (!primaryKeyModified) {
    // Primary key is not modified so there is nothing to be checked.
    return;
  }

  if (rows.length > 1) {
    // Primary key is set to the same value for multiple rows. The query syntax
    // for update accepts only literals as values therefore all modified rows
    // will result in having the same value for the affeted column.
    throw new lf.Exception(
        lf.Exception.Type.CONSTRAINT,
        'Primary key violation when updating rows for ' + table.getName());
  } else {
    this.checkPrimaryKeyExistence_(table, [rows[0]]);
  }
};


/**
 * @param {!lf.schema.Table} table
 * @param {!Array.<!lf.Row>} rows
 */
lf.cache.Journal.prototype.update = function(table, rows) {
  this.checkScope_(table);
  this.checkPrimaryKeyUpdate_(table, rows);

  var diff = new lf.cache.TableDiff();
  rows.forEach(function(row) {
    var oldRow = /** @type {!lf.Row} */ (this.cache_.get([row.id()])[0]);
    diff.modify([oldRow, row]);
  }, this);

  this.applyTableDiff_(table, diff);
};


/**
 * @param {!lf.schema.Table} table
 * @param {!Array.<!lf.Row>} rows
 */
lf.cache.Journal.prototype.insertOrReplace = function(table, rows) {
  this.checkScope_(table);

  var diff = new lf.cache.TableDiff();
  rows.forEach(function(row) {
    var existingRowId = this.findExistingRowIdInPkIndex_(table, row);
    if (goog.isDefAndNotNull(existingRowId)) {
      var oldRow = /** @type {!lf.Row} */ (
          this.cache_.get([existingRowId])[0]);
      row.setRowId(existingRowId);
      diff.modify([oldRow, row]);
    } else {
      diff.add(row);
    }
  }, this);

  this.applyTableDiff_(table, diff);
};


/**
 * Finds if any row with the same primary key exists in the primary key index.
 * @param {!lf.schema.Table} table The table where the row belongs.
 * @param {!lf.Row} row The row whose primary key needs to checked.
 * @return {?number} The row ID of an existing row that has the same primary
 *     key as the input row, on null if no existing row was found.
 * @private
 */
lf.cache.Journal.prototype.findExistingRowIdInPkIndex_ = function(
    table, row) {
  var pkIndexSchema = table.getConstraint().getPrimaryKey();
  if (goog.isNull(pkIndexSchema)) {
    // There is no primary key for the given table.
    return null;
  }

  var pkIndexName = pkIndexSchema.getNormalizedName();
  var primaryKey = /** @type {!lf.index.Index.Key} */ (
      row.keyOfIndex(pkIndexName));
  var pkIndex = this.indexStore_.get(pkIndexName);

  var rowIds = pkIndex.get(primaryKey);
  return rowIds.length == 0 ? null : rowIds[0];
};


/**
 * @param {!lf.schema.Table} table
 * @param {!Array.<!lf.Row>} rows
 */
lf.cache.Journal.prototype.remove = function(table, rows) {
  this.checkScope_(table);

  var diff = new lf.cache.TableDiff();
  rows.forEach(function(row) {
    diff.delete(row);
  }, this);

  this.applyTableDiff_(table, diff);
};


/**
 * Commits journal changes into cache and indices.
 */
lf.cache.Journal.prototype.commit = function() {
  goog.asserts.assert(
      !this.terminated_, 'Attemptted to commit a terminated journal.');
  this.terminated_ = true;
};


/**
 * Rolls back all the changes that were made in this journal from the cache and
 * indices.
 */
lf.cache.Journal.prototype.rollback = function() {
  goog.asserts.assert(
      !this.terminated_, 'Attempted to rollback a terminated journal.');

  this.tableDiffs_.forEach(
      function(tableDiff, tableName) {
        var tableSchema = this.scope_.get(tableName);
        var reverseDiff = tableDiff.getReverse();
        this.updateTableIndices_(tableSchema, reverseDiff);
        this.updateCache_(reverseDiff);
      }, this);

  this.terminated_ = true;
};


/**
 * Applies a set of changes to the indices and the cache.
 * @param {!lf.schema.Table} table The table to be updated.
 * @param {!lf.cache.TableDiff} diff The difference to be applied.
 * @private
 */
lf.cache.Journal.prototype.applyTableDiff_ = function(table, diff) {
  // Order of updating cache and indices does not matter, all the information
  // needed for updating already resides in the diff itself.
  this.updateTableIndices_(table, diff);
  this.updateCache_(diff);

  var accumulativeTableDiff = this.tableDiffs_.get(table.getName(), null) ||
      new lf.cache.TableDiff();
  this.tableDiffs_.set(table.getName(), accumulativeTableDiff);
  accumulativeTableDiff.merge(diff);
};


/**
 * Merge contents of journal into cache.
 * @param {!lf.cache.TableDiff} diff
 * @private
 */
lf.cache.Journal.prototype.updateCache_ = function(diff) {
  diff.getDeleted().getValues().forEach(
      function(row) {
        this.cache_.remove([row.id()]);
      }, this);
  diff.getAdded().forEach(function(row, rowId) {
    this.cache_.set([row]);
  }, this);
  diff.getModified().forEach(function(modification, rowId) {
    this.cache_.set([modification[1]]);
  }, this);
};


/**
 * @param {!lf.schema.Table} table The table to be updated.
 * @param {!lf.cache.TableDiff} diff The difference to be applied.
 * @private
 */
lf.cache.Journal.prototype.updateTableIndices_ = function(table, diff) {
  // Finding the "now" and "then" values for all affected rows.
  var snapshot = [];
  diff.getDeleted().getValues().forEach(
      /**
       * @param {!lf.Row} row
       */
      function(row) {
        snapshot.push([ /* now */ null, /* then */ row]);
      }, this);
  diff.getModified().getValues().forEach(
      /**
       * @param {!Array.<!lf.Row>} modification
       */
      function(modification) {
        snapshot.push(
            [/* now */ modification[1], /* then */ modification[0]]);
      }, this);
  diff.getAdded().getValues().forEach(
      /**
       * @param {!lf.Row} row
       */
      function(row) {
        snapshot.push([ /* now */ row, /* then */ null]);
      }, this);

  /** @type {!Array.<!lf.index.Index>} */
  var indices = table.getIndices().map(
      /**
       * @param {!lf.schema.Index} indexSchema
       * @this {!lf.cache.Journal}
       */
      function(indexSchema) {
        return this.indexStore_.get(indexSchema.getNormalizedName());
      }, this).concat([this.indexStore_.getRowIdIndex(table.getName())]);

  indices.forEach(
      /** @param {!lf.index.Index} index */
      function(index) {
        snapshot.forEach(function(pair) {
          var keyNow = goog.isNull(pair[0]) ? null :
              pair[0].keyOfIndex(index.getName());
          var keyThen = goog.isNull(pair[1]) ? null :
              pair[1].keyOfIndex(index.getName());
          if (keyNow != keyThen) {
            if (!goog.isNull(keyThen)) {
              index.remove(keyThen, pair[1].id());
            }
            if (!goog.isNull(keyNow)) {
              index.set(keyNow, pair[0].id());
            }
          }
        });
      });
};


/**
 * Checks that the given table is within the declared scope.
 * @param {!lf.schema.Table} tableSchema
 * @throws {!lfException}
 * @private
 */
lf.cache.Journal.prototype.checkScope_ = function(tableSchema) {
  if (!this.scope_.containsKey(tableSchema.getName())) {
    throw new lf.Exception(
        lf.Exception.Type.SCOPE_ERROR,
        tableSchema.getName() + ' is not in the journal\'s scope.');
  }
};