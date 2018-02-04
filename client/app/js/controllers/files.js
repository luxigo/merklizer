/*
* Copyright (c) 2018 ALSENET SA
*
* Author(s):
*
*      Luc Deschenaux <luc.deschenaux@freesurf.ch>
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Affero General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* (at your option) any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Affero General Public License for more details.
*
* You should have received a copy of the GNU Affero General Public License
* along with this program.  If not, see <http://www.gnu.org/licenses/>.
*
*/

'use strict';

/**
 * @ngdoc function
 * @name merkleApp.controller:FilesCtrl
 * @description
 * # FilesCtrl
 * Controller of the merkleApp
 */

module.exports=[
  '$scope',
  '$rootScope',
  '$window',
  '$timeout',
  '$q',
  'merkle',
  'tierion',
  'ethService',
  function (
    $scope,
    $rootScope,
    $window,
    $timeout,
    $q,
    merkle,
    tierion,
    ethService
  ) {
    this.awesomeThings = [
      'HTML5 Boilerplate',
      'AngularJS',
      'Karma'
    ];

    angular.extend($scope,{
      $rootScope: $rootScope,
      merkle: merkle,
      mimeTypes: '',
      isHTML5: true,
      queue: [],
      showFileList: true,
      itemsByPage: 10,
      progress: {
        max: 0,
        value: 0
      },
      init: function() {

      }, // init

      process: function(){
        $rootScope.$broadcast('processFiles',$scope.queue);
      },

      showOverlay: function(options){
        $rootScope.$broadcast('showOverlay',options);
      },

      hideOverlay: function(){
        $rootScope.$broadcast('hideOverlay');
      },

      removeDuplicates: function(){
        var fileList=$scope.queue;
        var hasDuplicate=0;
        var removedDuplicate=0;
        angular.forEach(fileList,function(file, i){
          for(var j=fileList.length-1; j>i; --j) {
            if (fileList[j].hash.toString()==fileList[i].hash.toString()) {
              if (
                fileList[j].name!=fileList[i].name
                || fileList[j].size!=fileList[i].size
              ) {
                fileList[j].duplicate=true;
                ++hasDuplicate;
                console.log('hash collision', fileList[j]);
              } else {
                console.log('removing duplicate', fileList[j]);
                fileList.splice(j,1);
                ++removedDuplicate;
              }
            }
          }
        });
        if (hasDuplicate) {
          $window.alert(hasDuplicate+" file"+(hasDuplicate>1?'s':'')+" with the same hash !");
        }
        if (removedDuplicate) {
          $window.alert(removedDuplicate+" duplicate"+(removedDuplicate>1?'s':'')+" ignored !");
        }
      }, // removeDuplicates

      onFilesDropped: function($files, $event) {
        $scope.progress.max=$files.length-1;
        $scope.progress.value=0;
        $scope.showOverlay('Adding files...');
        // reuse or initialize total size
        $scope.queue.size=$scope.queue.size||0;
        // update total size and store file
        angular.forEach($files,function(file,i) {
          $scope.progress.value=i;
          $scope.queue.size+=file.size;
          $scope.queue.push(file);
        });
        $scope.computeHashes($scope.queue)
        .then($scope.removeDuplicates)
        .finally($scope.hideOverlay);

      }, // onFilesDropped

      onFilesChanged: function($event,files){
         $scope.onFilesDropped($event.target.files,$event)
         $scope.$apply();
      }, // onFilesChanged

      remove: function(file){
        if ($window.confirm('Are you sure ?')) {
          $scope.queue.some(function(_file,i){
            if (file==_file){
              $scope.queue.splice(i,1);
              $scope.$apply();
              return true;
            }
          });
        }
      },

      removeAll: function(){
        if ($window.confirm('Are you sure ?')) {
          $scope.queue.splice(0,$scope.queue.length);
          $scope.queue.size=0;
        }
      },

      /**
      @function computeHashes
      @description compute hashes for given file list
      @param fileIndex
      @returns $q.promise
      */

      computeHashes: function(fileList){
        var q=$q.defer();

        /**
        @function computeFileHash
        @description compute hash for given file
        @param fileList
        @param fileIndex
        @returns $q.promise
        */
        function computeFileHash(fileList,fileIndex){
          var file=fileList[fileIndex];
          if (!file) return $q.resolve(-1);

          if (!$scope.reader) {
            $scope.reader=new FileReader();
          }

          var q=$q.defer();

          $scope.reader.addEventListener('load',function listener(e){
            file.hash=merkle.hash($scope.reader.result);
            file.hash_str=merkle.hashToString(file.hash);
            $scope.reader.removeEventListener('load',listener);
            q.resolve(fileIndex+1);
          });

          $scope.reader.readAsArrayBuffer(file);

          return q.promise;
        }

        // dont use 'reduce' to be nice with CPU
        // and to allow cancelling the task
        function loop(fileList,fileIndex) {
          var file=fileList[fileIndex];
          if (!file) {
            return q.resolve();
          }
          if (file.hash) {
            return loop(fileList,fileIndex+1);
          }

          computeFileHash(fileList,fileIndex)
          .then(function(index){
            if (index>0) {
              loop(fileList,index);

            } else {
              q.resolve();
            }
          })
          .catch(q.reject);
        }

        loop(fileList,0);

        return q.promise;

      } // computeHashes

    });

  }

];
