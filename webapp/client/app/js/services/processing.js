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

var JSZip=require('jszip');
const Buffer = require('safe-buffer').Buffer;
const QRCode = require('qrcode-svg')

if (!TextDecoder) {
  const TextDecoder=require('text-encoding').TextDecoder;
}
if (!TextEncoder) {
  const TextDecoder=require('text-encoding').TextEncoder;
}

module.exports = [
  '$q',
  '$rootScope',
  '$window',
  '$timeout',
  'merkle',
  'ethService',
  'btcService',
  'fileService',
  'FileSaver',
//  'pdfService',

  function(
    $q,
    $rootScope,
    $window,
    $timeout,
    merkle,
    ethService,
    btcService,
    fileService,
    FileSaver,
//    pdfService

  ) {
    var service=this;
    angular.extend(service,{
      prefix: '',
      blocksToGo: 1, // -1 == infinite

      cached_transactions: {},
      cached_blocks: {},

      init: function(){
      }, // init

      showOverlay: function(options){
        $rootScope.$broadcast('showOverlay',options);
      },

      hideOverlay: function(){
        $rootScope.$broadcast('hideOverlay');
      },

      processFiles: function processFiles(queue){
        service.showOverlay({
          message: 'Processing files...',
          showProgress: true
        });

        function pushAnchor(anchor){
          queue.anchors=queue.anchors||[];
          queue.anchors.push(anchor);
        }

        var q=merkle.compute(queue)
        .then(function(tree){
          service.tree=tree;
        });

        // Ethereum
        if (ethService.enabled) {

          q=q.then(function() {
            service.showOverlay({
              message: 'Please submit or reject transaction using Metamask.',
              showProgress: false,
              showButton: true
            });
            // check default account again
            return ethService.init()
            .then(function(){
              if (!ethService.account) {
                 throw new Error('You must login with MetaMask first !');
              }
              return ethService.eth.sendTransaction({
                from: ethService.account,
                to: ethService.account,
                value: '0',
                data: '0x'+service.prefix+merkle.getRoot(service.tree),
                gas: '25000'
              })
              .then(function(result) {
                service.showOverlay({
                  message: 'Waiting for receipt...',
                  showProgress: true,
                  showButton: true
                });
                var _q=$q.defer();
                $timeout(function(){
                  _q.resolve(result);
                },10000);
                return _q.promise;
              })
              .then(function getTransaction_loop(result,options){
                console.log(result);
                var stopHere=false;
                var blocksToGo=service.blocksToGo;
                return ethService.eth.getTransactionReceipt(result)
                .then(function(receipt){
                  if (!receipt || !receipt.blockNumber) {
                    var qq=$q.defer();
                    $timeout(function(){
                      getTransaction_loop(result)
                      .then(qq.resolve);
                    },10000);
                    return qq.promise;

                  } else {
                    if (receipt.status!=1) {
                      throw new Error('Transaction failed !');
                    }
                    return receipt;
                  }
                })
                .then(function waitNextBlocks(receipt, looping){
                  if (!receipt) {
                    return;
                  }

                  // maybe the receipt block number changed while waiting (?)
                  if (options && options.blockNumber.eq(receipt.blockNumber)) {
                    return receipt;
                  }

                  if (!looping) {
                    service.showOverlay({
                      message: 'Waiting for block confirmations...',
                      showProgress: true,
                      showButton: false
                    });
                  }

                  return ethService.eth.blockNumber()
                  .then(function(blockNumber){
                    if (stopHere) {
                      return;
                    }

                    if (!receipt) {
                      console.log('huh??');
                      return;
                    }

                    var blocksCount=blockNumber.sub(receipt.blockNumber);
                    console.log('blocks after: '+blocksCount);

                    if ((service.blocksToGo>0 && blocksCount>=service.blocksToGo) || stopHere) {
                      // just to be sure... maybe the transaction block number changed while waiting
                      return getTransaction_loop(result,{blockNumber: receipt.blockNumber});

                    } else {
                      // wait more blocks
                      var n;
                      var message;

                      if (service.blocksToGo>0) {
                        if (blocksCount>0) {
                          n=blocksToGo=service.blocksToGo-blocksCount;
                        } else {
                          n=blocksToGo;
                        }
                        message='Waiting for '+n+' more confirmation'+(n>1?'s':'')+'...';

                      } else {
                        if (blocksCount>0) {
                          message=blocksCount+' confirmation'+(blocksCount>1?'s':'')+' so far.';
                        } else {
                          message=null;
                        }
                      }

                      var qqq=$q.defer();

                      service.showOverlay({
                        message: message,
                        showProgress: true,
                        showButton: true,
                        buttonText: 'Stop',
                        onclick: function(){
                          stopHere=true;
                          qqq.resolve(getTransaction_loop(result,{blockNumber: receipt.blockNumber}));
                        }
                      });

                      $timeout(function(){
                        waitNextBlocks(receipt,true)
                        .then(qqq.resolve);
                      },20000);
                      return qqq.promise;
                    }
                  });

                })
                .then(function(receipt){
                  if (!receipt) {
                    console.log('huh');
                    return $q.resolve();
                  }
                  console.log(JSON.stringify(receipt,false,4));
                  return $q.resolve(receipt)
                  .then(service.getTransactionBlock)
                  .then(function(receipt){
                    pushAnchor({
                      type: 'ethereum',
                      networkId: parseInt(ethService.netId),
                      transactionId: receipt.transactionHash,
                      blockId: receipt.block.hash,
                      blockDate: service.getBlockDate(receipt.block)
                    });
                  });
                });
              });
            });
          });
        }

        if (btcService.enabled) {
          q=q.then(function() {
            service.showOverlay({
              message: 'Submitting Bitcoin transaction...',
              showProgress: false,
              showButton: false
            });
            return btcService.sendTransaction({
              from: btcService.keyPair.getAddress(),
              to: btcService.keyPair.getAddress(),
              data: new Buffer(merkle.stringToHash(service.prefix+merkle.getRoot(service.tree)).buffer),
              satoshis: 0,
              fees: 10000
            })
            .then(function getBitcoinTransaction_loop(receipt){
              service.showOverlay({
                message: 'Waiting for Bitcoin transaction confirmation...',
                showProgress: true,
                showButton: false
              });
              return btcService.getTransaction(receipt.txid)
              .then(function(transaction){
                console.log(transaction);
                if (transaction.confirmations<1) {
                  var qq=$q.defer();
                  $timeout(function(){
                    getBitcoinTransaction_loop(receipt)
                    .then(qq.resolve)
                    .catch(qq.reject);
                  },30000);
                  return qq.promise;

                }
                pushAnchor({
                  type: 'bitcoin',
                  networkId: btcService.networkId,
                  transactionId: transaction.txid,
                  blockId: transaction.blockhash,
                  blockDate: new Date(transaction.blocktime*1000).toISOString()
                });
              });
            });
          });
        }

        q.then(function(){
          return service.downloadArchive(queue);
        })
        .then(function(success){
          if (success) {
            $timeout(function(){
              $rootScope.$broadcast('filesProcessed',{files: queue});
            },150);
          }
        })
        .catch(function(err){
          service.hideOverlay();
          console.log('Error !',err);
          $window.alert(err.message||(err.value&&err.value.message&&err.value.message.split('\n')[0])||'Unexpected error !');
        })
/*
        .finally(function(){
          service.hideOverlay();
        });
*/
      }, // processFiles

      getReadableProof: function(proof) {
        var dec=new TextDecoder();
        return {
          hashType: proof.hashType,
          root: merkle.hashToString(proof.root),
          hash: merkle.hashToString(proof.hash),
          info: dec.decode(proof.info),
          operations: (function(){
            var result=[];
            proof.operations.forEach(function(op){
              if (op.left) {
                result.push({left: merkle.hashToString(op.left)});
              } else {
                if (op.right) {
                  result.push({right: merkle.hashToString(op.right)});
                } else {
                  throw new Error('invalid proof');
                }
              }
            });
            return result;
          })(),
          anchors: proof.anchors,
          date: proof.date
        }
      }, // getReadableProof

      downloadArchive: function downloadArchive(queue){
        var q=$q.defer();

        service.showOverlay({
          message: 'Build archive...',
          showProgress: true
        });

        try {
          var zip=new JSZip();
          var merkleRoot=merkle.getRoot(service.tree);
          var folder=zip.folder(/*merkleRoot*/);

          function addFileToArchive(file) {
            var json=JSON.stringify(service.getReadableProof(file.proof),false,2);
            folder.file(file.name+'.json',json);
            folder.file(file.name+'.svg',new QRCode(json).svg());
          }

          (function loop(i){
            if (i>=queue.length) {
              q.resolve();
              return
            }
            var file=queue[i];
            file.proof.anchors=queue.anchors;
            var nextFile=queue[i+1];

            // When the next file has the same name plus a '.txt' extension,
            // include its content in proof.info (it's hash will match the first
            // hash in the proof, ie proof.operations[0].right)
            if (file.isInfo) {
              // then skip such text file
              loop(i+1);
              return;

            } else if (file.name.match(/\.txt$/i)) {
              // When the file is a "standalone" text file, include
              // its content in file.proof.data
              $q.resolve().then(function(){
                return fileService.read(file,'readAsArrayBuffer');
              })
              .then(function(result){
                file.proof.data=result;
                addFileToArchive(file);
                loop(i+1);
              })
              .catch(q.reject);
              return;

            } else if (nextFile && nextFile.name==file.name+'.txt') {
              nextFile.isInfo=true;
              $q.resolve().then(function(){
                return fileService.read(nextFile,'readAsArrayBuffer');
              })
              .then(function(result){
                file.proof.info=result;
              })
              .then(function(){
                addFileToArchive(file);
                loop(i+1);
              })
              .catch(q.reject);
              return;

            } else {
              addFileToArchive(file);
              loop(i+1);
              return;
            }

          })(0);

          return q.promise.then(function(){
            var q=$q.defer();
            zip.generateAsync({type:"blob"}).then(function(content) {
              service.showOverlay({
                hideDialog: true
              });
              FileSaver.saveAs(content, "proofs-"+merkleRoot+".zip");
              service.hideOverlay();
              q.resolve(true);
            });
            return q.promise;
          })
          .catch(function(err) {
            console.log(err);
            $window.alert(err.message);
            service.hideOverlay();
          })

        } catch(e) {
          console.log(e);
          q.reject(e);
        }
        return q.promise;

      }, // downloadArchive

      getTransactionBlock: function(transaction,options){
        // get block
        if (transaction.block) {
          return transaction;
        } else {
          if ((options&&options.cache) && service.cached_blocks[transaction.blockHash]) {
            transaction.block=service.cached_blocks[transaction.blockHash];
            return transaction;
          }

          return ethService.eth.getBlockByHash(transaction.blockHash,false)
          .then(function(block){
            if (options&&options.cache) {
              service.cached_blocks[block.hash]=block;
            }
            transaction.block=block;
            console.log(JSON.stringify(block,false,4));
            return transaction;
          })
        }
      },

      getBlockDate: function(block) {
        return new Date(block.timestamp*1000).toISOString();
      },

      encodeAndHash: function(proof,propertyName){
        if (proof[propertyName] && !proof[propertyName+'_hash']) {
          var enc=new TextEncoder();
          proof[propertyName]=enc.encode(proof[propertyName]);
          return merkle.hash(proof[propertyName],proof.hashType)
          .then(function(hash){
            proof[propertyName+'_hash']=hash;
          });
        } else {
          return $q.resolve();
        }
      },

      validate: function(file, options) {
        options=options||{};

        if (!file.proof) {
          console.log('no merkle proof',file);
          if (!options.silent) {
            $window.alert('No merkle proof !');
          }
          return $q.resolve(false);
        }

        if (file.proof.validated!==undefined) {
          return $q.resolve(file.proof.validated);
        }

        if (file.hash && merkle.hashToString(file.proof.hash)!=merkle.hashToString(file.hash)) {
          console.log('hash mismatch between file and proof !',file);
          if (!options.silent) {
            $window.alert('Hash mismatch between file and proof !');
          }
          file.proof.validated=false;
          return $q.resolve(false);
        }

        if (file.proof.info) {
          var info_hash=file.proof.info_hash=merkle.hashToString(file.proof.info_hash);
          var hashright;
          if (file.proof.operations && file.proof.operations[0] && file.proof.operations[0].right) {
            hashright=merkle.hashToString(file.proof.operations[0].right);
          }
          if (
            info_hash!=merkle.hashToString(file.proof.hash)
            && (hashright && info_hash!=hashright)
          ) {
            console.log('hash mismatch between description and proof !',file);
            if (!options.silent) {
              $window.alert('Hash mismatch between description and proof !');
            }
            file.proof.validated=false;
            return $q.resolve(false);
          }
        }

        var promises=[];
        file.proof.anchors.forEach(function(anchor){
          switch(anchor.type) {
            case 'ethereum':
              if (ethService.enabled) {
                anchor.validated=false;
                promises.push(validateEthereumAnchor(anchor));
              }
              break;
            case 'bitcoin':
              if (btcService.enabled) {
                anchor.validated=false;
                promises.push(validateBitcoinAnchor(anchor));
              }
              break;
          }
        });

        function validateEthereumAnchor(anchor) {
          var q=$q.resolve();

          service.showOverlay({
            message: 'Retrieving ethereum transaction...',
            showProgress: true,
            showButton: true
          });

          return q.then(function() {
            // check default account again
            return ethService.init(anchor.networkId);

          })
          .then(function(){
            ethService.account && console.log('account '+ethService.account);

            // check network id
            if (ethService.netId!=anchor.networkId) {
              throw new Error('You are connected on '+ethService.network_name[ethService.netId]+' but the Merkle root has been anchored to '+ethService.network_name[anchor.networkId]);
            }

            // get transaction
            if (options && options.cache && service.cached_transactions[anchor.transactionId]) {
              return service.cached_transactions[anchor.transactionId];
            } else {
              return ethService.eth.getTransactionByHash(anchor.transactionId)
              .then(function(transaction){
                if (options && options.cache) {
                  service.cached_transactions[anchor.transactionId]=transaction;
                }
                console.log(JSON.stringify(transaction,false,4));
                return transaction;
              });
            }
          })

          // get block
          .then(service.getTransactionBlock)

           // validate data
          .then(function(transaction){

            // check block hash
            if (transaction.block.hash!=anchor.blockId) {
              throw new Error('Block hash mismatch !');
            }

            // check block date
            if (service.getBlockDate(transaction.block)!=anchor.blockDate) {
              throw new Error('Block date mismatch !');
            }

            anchor.transaction=transaction;
            return validateAnchor(file, anchor);


          });
        } // validateEthereumAnchor

        function validateAnchor(file, anchor) {
          service.showOverlay({
            message: 'Checking Merkle proof...',
            showProgress: true,
            showButton: true
          });

          // check file hash
          if (file.hash && merkle.hashToString(file.hash)!=file.proof.hash) {
            throw new Error('File hash mismatch !');
          }

          // check merkle root
          var root=file.proof.root;

          if (typeof root != 'string') {
            // allow validating files just processed
            root=merkle.hashToString(root);
          } else {
            // final comparison expects Uint8Array
            file.proof.root=merkle.stringToHash(root);
          }

          // compare merkle roots
          var txroot;
          switch(anchor.type) {
            case 'ethereum':
              txroot=anchor.transaction.input.slice(anchor.transaction.input.length-root.length);
              break;
            case 'bitcoin':
              anchor.transaction.vout.some(function(out){
                if (out.value==0) {
                  var script=out.scriptPubKey.asm.split(' ');
                  if (script[0]=='OP_RETURN') {
                    txroot=script[1];
                    return true;
                  }
                }
              });
              break;
          }

          if (txroot!=root) {
            throw new Error('Merkle root mismatch !');
          }

          // check merkle proof
          return merkle.checkProof(file.proof).then(function(validated){
            anchor.validated=validated;
            console.log((file.name||merkle.hashToString(file.proof.hash))+' validated on '+anchor.type+'('+anchor.networkId+'): ',validated.toString());
            return validated;
          });

        } // validateAnchor

        function validateBitcoinAnchor(anchor){
          service.showOverlay({
            message: 'Retrieving bitcoin transaction...',
            showProgress: true,
            showButton: true
          });

          // check network id
          if (btcService.networkId!=anchor.networkId) {
            return $q.reject(new Error('You are connected on '+btcService.networkId+' but the Merkle root has been anchored to '+anchor.networkId));
          }

          return $q.resolve().then(function() {
            return btcService.getTransaction(anchor.transactionId)
            .then(function(transaction){
              console.log(transaction);
              anchor.transaction=transaction;
              // compare timestamp
              if (anchor.blockDate!=new Date(transaction.blocktime*1000).toISOString()) {
                throw new Error('Bitcoin block date mismatch');
              }
              if (anchor.blockId!=transaction.blockhash) {
                throw new Error('Bitcoin block hash mismatch');
              }
              return validateAnchor(file,anchor);
            });
          });
        }

        return $q.all(promises).then(function(){
          var validated=false;
          file.proof.anchors.some(function(anchor){
            if (anchor.validated!==undefined) {
              validated=anchor.validated;
              return !validated;
            }
          });
          file.proof.validated=validated;
          return validated;
        }).then(function(validated){
          service.showOverlay({
            message: '',
            showProgress: false,
            showButton: false
          });
          var q=$q.defer();
          $timeout(function(){
            q.resolve(validated);
          },1000);
          return q.promise;

        })
        .then(function(validated){
          if (!options.silent) {
            $window.alert('The proof was '+(validated?'successfuly':'NOT')+' validated !');
          }
          return validated;

        })
        .catch(function(err){
          service.hideOverlay();
          console.log('Error !',err);
          $window.alert(err.message||(err.value&&err.value.message&&err.value.message.split('\n')[0])||'Unexpected error !');

        })
        .finally(function(){
          service.hideOverlay();
        });

      }, // validate

      showProof: function(proof,title){
        proof=service.getReadableProof(proof);
        var w=$window.open('',title||proof.hash);
        $timeout(function(){
          w.document.open();
          w.document.write('<html><head><meta charset="UTF8" /><title>'+(title||proof.hash)+'</title></head><body><pre>'+JSON.stringify(proof,false,2)+'</pre></body></html>');
          w.document.close();
        });
      }, // showProof

      showAllAnchors: function(anchors){
        angular.forEach(anchors,function(anchor){
          service.showAnchor(anchor);
        });
      },

      showAnchor: function(anchor){
        switch(anchor.type) {
          case 'ethereum':
            $window.open(service.getAnchorUrl(anchor),anchor.transactionId);
            break;
        }
      },

      getAnchorUrl: function(anchor) {
        switch(anchor.type) {
          case 'ethereum':
             var subdomain=(anchor.networkId==1)?'':(ethService.network_name[anchor.networkId]+'.');
             return 'https://'+subdomain+'etherscan.io/tx/'+anchor.transactionId;
         }
      }, // getAnchorUrl

      validateAll: function(files) {
        var q=$q.defer();
        var count=0;
        var index=0;
        (function loop(){
          var file=files&&files[index++];
          if (!file) {
            q.resolve();
            return;
          }
          if (!file.proof) {
            loop();
            return;
          }
          ++count;
          if (file.proof.validated) {
            loop();
            return;
          }
          service.validate(file,{
            silent: true
          })
          .then(loop);

        })();

        return q.promise.then(function(){
          $rootScope.$broadcast('filesValidated',files);
        });

      } // validateAll

    });

    service.init();
  }
]
