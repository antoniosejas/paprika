// inline workers from:
// https://github.com/dreame4/inline-worker

;(function (__global__) {
	'use strict';

	function isWorkerSupported() {
		return !!__global__.Worker;
	}

	function InlineWorker(fn, imports) {
		if (!isWorkerSupported()) {
			throw new Error('Web Worker is not supported');
		}

		if (!(this instanceof InlineWorker)) {
			return new InlineWorker(fn, imports);
		}

		this.fnBody = 'self.onmessage = function (event) { self.postMessage( (' 
        + fn.toString() 
        + ').call(self, event.data) ) };';
        
        this.imports = "";
        
        if(imports){
            this.imports += "importScripts('" + imports + "');";
        }
        
		this.worker = this.resolve = this.reject = this.onmessage = this.onerror = null;
		this.injected = [];
	}

	InlineWorker.prototype = {
		constructor: InlineWorker,

		_assertWorker: function assertWorker() {
			var blob;

			if (this.worker) {
				return;
			}
			blob = new Blob([this.imports.concat(this.fnBody)].concat(this.injected), 
                            { type: "application\/javascript" });
			this.worker = new Worker(__global__.URL.createObjectURL(blob));
		},

		run: function run(message, transferList) {
			this._assertWorker();
//			this.worker.postMessage(message, transferList || null);
			this.worker.postMessage(message);
			this.worker.onmessage = this._onMessage.bind(this);
			this.worker.onerror = this._onError.bind(this);
			return this;
		},

		_onMessage: function onMessage(e) {
			this.resolve = e.data;
			// if then() has already been called
			if (this.onmessage) {
				this.onmessage(e.data);
			}
		},

		_onError: function onError(e) {
			this.reject = e;
			// if then() has already been called
			if (this.onerror) {
				this.onerror(e.message, e.filename, e.lineno, e);
			}
		},

		then: function then(success, error) {
			var err;
			//this._assertWorker();

			if (typeof success === 'function') {
				this.onmessage = success;
				// Worker finished execution
				if (this.resolve) {
					this.onmessage(this.resolve);
				}
			}
			if (typeof error === 'function') {
				this.onerror = error;
				// Worker finished execution
				if (this.reject) {
					err = this.reject;
					this.onerror(err.message, err.filename, err.lineno, err);
				}
			}
			return this;
		},

		inject: function inject() {
			var argv = Array.prototype.slice.call(arguments),
				argc = argv.length,
				i = 0,
				fn;

			for (; i < argc; i++) {
				fn = argv[i];
				if (typeof fn === 'function') {
					// @TODO: check if function is named
					this.injected.push(fn.toString());
				}
			}

			return this;
		}
	};

	__global__.InlineWorker = InlineWorker;

}(window));

// Paprika

var Paprika = Paprika || ( function () {
    // navigator compatibility
    navigator.getUserMedia  = navigator.getUserMedia
                           || navigator.webkitGetUserMedia
                           || navigator.mozGetUserMedia
                           || navigator.msGetUserMedia;

    if (!!navigator.getUserMedia) console.log("Camera OK");
    else alert("No camera :(");

    var video;
    var videoCanvas;
    var localMediaStream = null;
    
    var camera;

    var waitForWorker = false;
    
    var worker = new InlineWorker(
        function(data) {            
            switch (data.type) {
                case "estimate":
                    return workerEstimate(data.img, data.w, data.h);
                    break;

                case "bundle":
                    return workerBundle(data.bundles);
                    break;

                case "camera":
                    return workerCameraInfo(data.w, data.h);
            }
        },
        "https://raw.githubusercontent.com/chili-epfl/paprika/master/js/chilitags.js"
    );
    
    function workerEstimate(img, w, h) {
        var inputBuf = Module._malloc(w*h);

        for(var i=0; i<img.data.length/4; i++){
            setValue(inputBuf+i, 
                     Math.min(0.299 * img.data[4*i] + 
                              0.587 * img.data[4*i+1] + 
                              0.114 * img.data[4*i+2], 
                              255), 
                     "i8");
        }

        var output = Module.ccall('estimate', 'string', ['int', 'int', 'int', 'boolean'], [inputBuf, w, h, false]);
        var objects = JSON.parse(output);
        Module._free(inputBuf);
        
        return {type:"estimate", objects:objects};
    };

    function workerBundle(bundles) {
        var configFile = '%YAML:1.0\n';
        for (var bundleId in bundles) {
            configFile += bundleId+':\n';
            var bundle = bundles[bundleId];
            for (var tagId in bundle) {
                configFile += '  - tag: '+tagId+'\n';
                var tagInfo = bundle[tagId];
                if ("size" in tagInfo) 
                    configFile += '    size: '+tagInfo["size"]+'\n';
                if ("translation" in tagInfo) 
                    configFile += '    translation: ['+tagInfo["translation"]+']\n';
                if ("rotation" in tagInfo) 
                    configFile += '    rotation: ['+tagInfo["rotation"]+']\n';
                if ("keep" in tagInfo) 
                    configFile += '    keep: '+tagInfo["keep"]+'\n';
            }
        }
        FS.createDataFile("/", "tagConfig.yml", configFile, true, true);
        Module.ccall('readTagConfiguration', 'void', ['string', 'boolean'], ["/tagConfig.yml", false]);
    };
    
    function workerCameraInfo() {;
        return {type:"camera", cameraMatrix:Chilitags.getCameraMatrix()};
    };
    
    worker.inject(workerEstimate, workerBundle, workerCameraInfo);

    // receive from worker
    worker.then( function(data) {
        if(data === undefined) {
            console.log("undefined data from worker...");
            return;
        }
        switch(data.type) {
            case "estimate":
                var objects = data.objects;

                for (var i=0; i<updateCallbacks.length; i++) {
                    updateCallbacks[i].call(this, objects);
                }
                for (var objectName in objects) {
                    if (objectName in objectCallbacks) {
                        var callbacks = objectCallbacks[objectName];
                        for (var i=0; i < callbacks.length; i++) {
                            callbacks[i].call(this, objects[objectName]);
                        }
                    }
                }

                waitForWorker = false;
                break;

            case "camera":
                var far = 1000, near = 10, width = 640, height = 480;
                var m = data.cameraMatrix;

                camera = new THREE.Camera();
                camera.projectionMatrix.set(
                    2*m[0]/width,              0,        2*m[2]/width-1,  0,
                               0, -2*m[4]/height,    -(2*m[5]/height-1),  0,
                               0,              0, (far+near)/(far-near), -2*far*near/(far-near),
                               0,              0,                     1,  0
                );

                break;
        }
    },
    function(error) {
      dump("Worker error: " + error.message + "\n");
      throw error;
    } );

    // list of functions to call back when tags have been detected in a new frame
    var updateCallbacks = [];

    // mapping from objects (aggregates of tags) to specific callbacks
    var objectCallbacks = {};

    // detection loop, calling the functions in updateCallbacks and objectCallbacks
    var loop = function() {
        if (localMediaStream && !waitForWorker) {
            var videoIsReady = false;
            while (!videoIsReady) {
                try {
                    videoCanvas.getContext('2d').drawImage(video, 0, 0, video.width, video.height);
                    videoIsReady = true;
                } catch (e) {
                    if (e.name.indexOf("NS_ERROR_NOT_AVAILABLE") == -1) throw e;
                }
            }
            var ctx = videoCanvas.getContext('2d');
            var img = ctx.getImageData(0, 0, videoCanvas.width, videoCanvas.height);

            // send the image info to the worker
            worker.run({type: "estimate", img: img, w: videoCanvas.width, h: videoCanvas.height});
            waitForWorker = true;
        }
        requestAnimationFrame(loop);
    }
    
    // helper functions
    
    var getPixelPosition = function(transformation) {
        // format the transformationMatrix into a THREE.Matrix4
        var transformationMatrix = new THREE.Matrix4();
        transformationMatrix.set.apply(transformationMatrix, transformation);

        var widthHalf = 320, heightHalf = 240;

        var vector = new THREE.Vector3();
        var projector = new THREE.Projector();
        projector.projectVector( vector.setFromMatrixPosition( transformationMatrix ), camera );

        var pixelPosX = Math.round(( vector.x * widthHalf ) + widthHalf);
        var pixelPosY = Math.round(- ( vector.y * heightHalf ) + heightHalf);
        
        return { x:pixelPosX, y:pixelPosY };
    }
    
    var getRotation = function(transformation, axis) {
        // format the transformationMatrix into a THREE.Matrix4
        var transformationMatrix = new THREE.Matrix4();
        transformationMatrix.set.apply(transformationMatrix, transformation);
        
        // compute the euler angles of the transformation, with Z as axis of
        // the first rotation, so that we can ignore rotation on X and Y.
        var angles = new THREE.Euler();
        angles.setFromRotationMatrix(transformationMatrix);
        
        switch(axis) {
            case "x":
                return angles.x;
                break;
            case "y":
                angles.reorder('YZX');
                return angles.y;
                break;
            case "z":
                angles.reorder('ZXY');
                return angles.z;
        }
    }
    
    var getTilt = function(transformation) {
        // format the transformationMatrix into a THREE.Matrix4
        var transformationMatrix = new THREE.Matrix4();
        transformationMatrix.set.apply(transformationMatrix, transformation);
        
        // extract the rotation components
        var rotationMatrix = new THREE.Matrix4();
        rotationMatrix.extractRotation(transformationMatrix);
        
        // compute normal tilt
        var objectNormal = new THREE.Vector3(0, 0, -1);
        objectNormal.applyMatrix4(rotationMatrix);
        var tilt = objectNormal.angleTo(new THREE.Vector3(0, 0, -1));
        
        // compute normal orientation
        var projectedNormal = new THREE.Vector3(objectNormal.x, objectNormal.y, 0);
        projectedNormal.normalize();
        
        var orientation = Math.atan2(projectedNormal.y, projectedNormal.x);
        while (orientation >= 2*Math.PI) orientation -= 2*Math.PI;
        while (orientation <          0) orientation += 2*Math.PI;
        
        return {tilt:tilt,
                orientation:orientation,
                normal3D:{x:objectNormal.x, y:objectNormal.y, z:objectNormal.z},
                normal2D:{x:projectedNormal.x, y:projectedNormal.y}
               };
    }

    return {

        start : function(divId, videoId, visible) {
            visible = typeof visible !== "undefined" ? visible : true;
            
            if(videoId !== undefined) video = document.getElementById(videoId);
            
            if(video === undefined || video == null) {
                video = document.createElement("video");
                video.autoplay = true;
                video.width = 640;
                video.height = 480;
                video.style.display = "none";
            }

            videoCanvas = document.createElement("canvas");
            videoCanvas.width = 640;
            videoCanvas.height = 480;
            
            if(!visible) {
                videoCanvas.style.display = "none";
            } else if(divId !== undefined && document.getElementById(divId) != null) {
                document.getElementById(divId).appendChild(videoCanvas);
            } else {
                document.body.appendChild(videoCanvas);
            }

            navigator.getUserMedia(
                {video: true},
                function(stream) {
                    window.URL = window.URL || window.webkitURL;
                    video.src = window.URL.createObjectURL(stream);
                    localMediaStream = stream;
                    video.play();
                },
                function(e) { console.log('Error!', e); }
            );
            
            worker.run({type: "camera", h:480, w:640});

            // start the detection
            //the timeOut is a work around Firefox's bug 879717
            video.addEventListener('play', function() {setTimeout(loop, 2500);}, false);
        },

        // registers a function to call when a new frame has been process by Chilitags
        onUpdate : function(callback) {
            updateCallbacks.push(callback);
        },
        
        // registers a function to call for every frame where `objectName` has been detected
        onRotationUpdate : function(callback, objectName, axis) {
            var trigger = function(transformation) {
                var rotation = getRotation(transformation, axis);

                callback({
                    objectName:objectName,
                    transformation:transformation,
                    rotation:rotation
                    });
            };
            
            // we add this trigger to the list of callbacks related to `objectName`
            if (objectName in objectCallbacks) objectCallbacks[objectName].push(trigger);
            else objectCallbacks[objectName] = [trigger];
            
            return trigger;
        },
        
        // registers a function to call for every frame where `objectName` has been detected
        onPositionUpdate : function(callback, objectName, axis) {
            var trigger = function(transformation) {
                var position = getPixelPosition(transformation);

                callback({
                    objectName:objectName,
                    transformation:transformation,
                    pixelPositionX:position.x,
                    pixelPositionY:position.y
                    });
            };
            
            // we add this trigger to the list of callbacks related to `objectName`
            if (objectName in objectCallbacks) objectCallbacks[objectName].push(trigger);
            else objectCallbacks[objectName] = [trigger];
            
            return trigger;
        },
        
        //registers a function to call for every frame where `objectName` has been deected
        onTiltUpdate : function(callback, objectName) {
            var trigger = function(transformation) {
                var tmp = getTilt(transformation);
                
                callback({
                    objectName:objectName,
                    transformation:transformation,
                    tilt:tmp.tilt,
                    orientation:tmp.orientation,
                    normal3D:tmp.normal3D,
                    normal2D:tmp.normal2D
                    });
            };
            
            // we add this trigger to the list of callbacks related to `objectName`
            if (objectName in objectCallbacks) objectCallbacks[objectName].push(trigger);
            else objectCallbacks[objectName] = [trigger];
            
            return trigger;
        },

        // registers a `callback`function to call when `objectName` has entered the view
        onAppear : function(callback, objectName) {

            // defines if object was present in previous frame
            var wasPresent = false;

            // the logic computing whether or not calling `callback`
            var trigger = function(objects) {
                // compute current visibility
                var isPresent = (objectName in objects);
                // detect if entered
                if(!wasPresent && isPresent) {
                    var transformation = objects[objectName];
                    
                    callback({ 
                        objectName:objectName,
                        transformation:transformation
                        });
                }
                // save current visibility
                wasPresent = isPresent;
            };
            trigger.reset = function() { wasPresent = false; }

            // we add this trigger to the list of callbacks
            updateCallbacks.push(trigger);

            return trigger;
        },

        // registers a `callback`function to call when `objectName` has exited the view
        onDisappear : function(callback, objectName) {

            // defines if object was present in previous frame
            var wasPresent = false;

            // the logic computing whether or not calling `callback`
            var trigger = function(objects) {
                // compute current visibility
                var isPresent = (objectName in objects);
                // detect if exited
                if(!isPresent && wasPresent) callback( {objectName:objectName} );
                // save current visibility
                wasPresent = isPresent;
            };
            trigger.reset = function() { wasPresent = false; }

            // we add this trigger to the list of callbacks
            updateCallbacks.push(trigger);

            return trigger;
        },

        // registers a `callback` function to call when `objectName` has been rotated
        // by at least `minDelta` radians
        onRotate : function(callback, objectName, minDelta) {

            // stores the initial orientation to compare against
            var previousOrientation = undefined;

            // the logic computing whether or not calling `callback` when an object's
            // transformation matrix has been updated
            var trigger = function(transformation) {
                // compute the euler angles of the transformation
                var orientation = getRotation(transformation, "z");

                // initialisation of previousOrientation
                if (previousOrientation === undefined) {
                    previousOrientation = orientation;

                    callback({
                        objectName:objectName,
                        transformation:transformation,
                        orientation:orientation,
                        delta:0});
                }

                // computing the rotation since `previousOrientation`,
                // and normalizing in ]-Math.PI, Math.PI]
                var delta = orientation-previousOrientation;
                while (delta >   Math.PI) delta -= 2*Math.PI;
                while (delta <= -Math.PI) delta += 2*Math.PI;

                // if the rotation is beyond the minDelta threshold, call the callback
                // and reset the reference orientation (previousOrientation)
                if (Math.abs(delta) > minDelta) {
                    callback({
                        objectName:objectName,
                        transformation:transformation,
                        orientation:orientation,
                        delta:delta});
                    previousOrientation = orientation;
                }
            };
            trigger.reset = function() { previousOrientation = undefined; }

            // we add this trigger to the list of callbacks related to `objectName`
            if (objectName in objectCallbacks) objectCallbacks[objectName].push(trigger);
            else objectCallbacks[objectName] = [trigger];

            return trigger;
        },

        // registers a `callback` function to call when `objectName` is within +/-
        // `epsilon` radians from `goalOrientation`, and when the orientation of
        // `objectName` changes again by at least `epsilon` radians. Note that this
        // sets a different threshold to avoid problematic border cases.
        // The default value for epsilon is 0.025 * Math.PI (9 degrees.)
        onOrient : function(callback, objectName, goalOrientation, epsilon) {
            epsilon = typeof epsilon !== 'undefined' ? epsilon : 0.025 * Math.PI;

            // keeps track of whether the orientation of the object is already within
            // the target orientation range
            var isIn = false;
            // keeps track of the orientation at which the object was detected to be
            // close enough from the goal orientation
            var triggeringOrientation;

            // same as onRotate...
            var trigger = function(transformation) {
                // compute the euler angles of the transformation
                var orientation = getRotation(transformation, "z");

                // ... but this time we compare the current orientation with the target
                // one if the object is not yet oriented as expected, or with the
                // orientation it had when it was deemed close enough form the target
                var delta = Math.abs(
                    (isIn?triggeringOrientation:goalOrientation)-orientation);

                while (delta >= 2*Math.PI) delta -= 2*Math.PI;
                while (delta <          0) delta += 2*Math.PI;
                
                // delta is a distance between two angles
                if (delta > Math.PI) delta = 2*Math.PI-delta;

                // if the object is oriented as expected but wasn't before, or vice
                // versa, we switch the state storing whether the goal is reached, and
                // we call the callback
                if (   !isIn && delta < epsilon
                    ||  isIn && delta > epsilon) {
                    isIn = !isIn;
                    if (isIn) {
                        triggeringOrientation = orientation;
                        callback({
                            objectName:objectName,
                            transformation:transformation,
                            orientation:orientation,
                            goalOrientation:goalOrientation,
                            hasEntered:isIn});
                    }
                }
            };
            trigger.reset = function() { isIn = false; }

            // we add this trigger to the list of callbacks related to `objectName`
            if (objectName in objectCallbacks) objectCallbacks[objectName].push(trigger);
            else objectCallbacks[objectName] = [trigger];

            return trigger;
        },

        // registers a `callback` function to call when `objectName` has been flipped
        // by roughly pi radians
        onFlip : function(callback, objectName) {

            // stores the initial flip state to compare against
            var previouslyFacing = undefined;

            // the logic computing whether or not calling `callback` when an object's
            // transformation matrix has been updated
            var trigger = function(transformation) {
                // compute the euler angles of the transformation
                var tmp = getTilt(transformation);
                var facing = tmp.tilt < 0.5 * Math.PI;

                // initialisation of previousOrientation
                if (previouslyFacing === undefined) {
                    previouslyFacing = facing;

                    callback({
                        objectName:objectName,
                        transformation:transformation,
                        tilt:tmp.tilt,
                        orientation:tmp.orientation,
                        facing:facing});
                }

                // if the object has changed orientation with respect to the camera,
                // call the callback and reset the reference orientation (previouslyFacing)
                if (facing !== previouslyFacing) {
                    callback({
                        objectName:objectName,
                        transformation:transformation,
                        tilt:tmp.tilt,
                        orientation:tmp.orientation,
                        facing:facing});
                    
                    previouslyFacing = facing;
                }
            };
            trigger.reset = function() {
                previouslyFacing = undefined;
            }

            // we add this trigger to the list of callbacks related to `objectName`
            if (objectName in objectCallbacks) objectCallbacks[objectName].push(trigger);
            else objectCallbacks[objectName] = [trigger];

            return trigger;
        },

        // registers a `callback` function to call when `objectName` has been tilted
        // past `limitAngle` radians
        onTilt : function(callback, objectName, limitAngle) {

            // stores the initial tilt to compare against
            var previouslyTilted = undefined;

            // the logic computing whether or not calling `callback` when an object's
            // transformation matrix has been updated
            var trigger = function(transformation) {
                // compute the euler angles of the transformation
                var tmp = getTilt(transformation);
                var tilted = tmp.tilt > limitAngle;

                // initialisation of previousOrientation
                if (previouslyTilted === undefined) {
                    previouslyTilted = tilted;

                    callback({
                        objectName:objectName,
                        transformation:transformation,
                        tilt:tmp.tilt,
                        orientation:tmp.orientation,
                        tilted:tilted});
                }

                // if the object has changed orientation with respect to the camera,
                // call the callback and reset the reference orientation (previouslyFacing)
                if (tilted != previouslyTilted) {
                    callback({
                        objectName:objectName,
                        transformation:transformation,
                        tilt:tmp.tilt,
                        orientation:tmp.orientation,
                        tilted:tilted});
                    
                    previouslyTilted = tilted;
                }
            };
            trigger.reset = function() {
                previouslyFacing = undefined;
            }

            // we add this trigger to the list of callbacks related to `objectName`
            if (objectName in objectCallbacks) objectCallbacks[objectName].push(trigger);
            else objectCallbacks[objectName] = [trigger];

            return trigger;
        },

        removeTrigger : function(trigger) {
            if(trigger.objectName === undefined) {
                var triggerIndex = updateCallbacks.indexOf(trigger);
                if (triggerIndex != -1) {
                    updateCallbacks.splice(triggerIndex, 1);
                    return true;
                }
            } else {
                if (trigger.objectName in objectCallbacks) {
                    var triggerIndex = objectCallbacks[trigger.objectName].indexOf(trigger);
                    if (triggerIndex != -1) {
                        objectCallbacks[trigger.objectName].splice(triggerIndex, 1);
                        return true;
                    }
                }
            }
            return false;
        },

        bundleTags : function(bundles) {
            worker.run({type: "bundle", bundles: bundles});
        }
    }

} )();