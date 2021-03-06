/**
 * @license
 * Copyright 2015 The Lovefield Project Authors. All Rights Reserved.
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
goog.provide('TestReporter');


/**
 * Need a custom test reporter such that WebDriver can detect test completion.
 * @constructor @struct
 */
TestReporter = function() {
  this.finished = false;
  this.success = false;
  this.report = '';
};


/** @return {boolean} */
TestReporter.prototype.isInitialized = function() {
  return true;
};


/** @return {boolean} */
TestReporter.prototype.isFinished = function() {
  return this.finished;
};


/** @return {boolean} */
TestReporter.prototype.isSuccess = function() {
  return this.success;
};


/** @return {string} */
TestReporter.prototype.getReport = function() {
  return this.report;
};


/** @return {number} */
TestReporter.prototype.getRunTime = function() {
  return 0;
};
