pc.extend(pc, function () {

    /**
     * @name pc.LayerComposition
     * @class Layer Composition is a collection of {@link pc.Layer} that is fed to {@link pc.Scene#layers} to define rendering order.
     * @description Create a new layer composition.
     * @property {Array} layerList A read-only array of {@link pc.Layer} sorted in the order they will be rendered.
     * @property {Array} subLayerList A read-only array of boolean values, matching {@link pc.Layer#layerList}.
     * True means only semi-transparent objects are rendered, and false means opaque.
     * @property {Array} subLayerEnabled A read-only array of boolean values, matching {@link pc.Layer#layerList}.
     * True means the layer is rendered, false means it's skipped.
     * @property {Array} cameras A read-only array of {@link pc.CameraComponent} that can be used during rendering, e.g. inside
     * {@link pc.Layer#onPreCull}, {@link pc.Layer#onPostCull}, {@link pc.Layer#onPreRender}, {@link pc.Layer#onPostRender}.
     */
    // Composition can hold only 2 sublayers of each layer
    var LayerComposition = function () {
        this.layerList = [];
        this.subLayerList = [];
        this.subLayerEnabled = []; // more granular control on top of layer.enabled (ANDed)

        this._dirty = false;
        this._dirtyBlend = false;
        this._dirtyLights = false;
        this._dirtyCameras = false;
        this._meshInstances = [];
        this._lights = [];
        this.cameras = [];
        this._sortedLights = [[], [], []];
        this._lightShadowCasters = []; // array of arrays for every light; identical arrays must not be duplicated, just referenced
        this._globalLightCameras = []; // array mapping _globalLights to cameras
        this._globalLightCameraIds = []; // array mapping _globalLights to camera ids in composition
        this._renderedRt = [];
        this._renderedByCam = [];
        this._renderedLayer = [];

        // generated automatically - actual rendering sequence
        // can differ from layerList/subLayer list in case of multiple cameras on one layer
        // identical otherwise
        this._renderList = []; // index to layerList/subLayerList
        this._renderListCamera = []; // index to layer.cameras

        pc.events.attach(this);
    };

    LayerComposition.prototype._sortLights = function (target) {
        var light;
        var lights = target._lights;
        target._sortedLights[pc.LIGHTTYPE_DIRECTIONAL].length = 0;
        target._sortedLights[pc.LIGHTTYPE_POINT].length = 0;
        target._sortedLights[pc.LIGHTTYPE_SPOT].length = 0;
        for (var i = 0; i < lights.length; i++) {
            light = lights[i];
            if (light._enabled) {
                target._sortedLights[light._type].push(light);
            }
        }
    };

    LayerComposition.prototype._update = function () {
        var i, j, k;
        var layer;
        var len = this.layerList.length;
        var result = 0;

        if (!this._dirty || !this._dirtyLights || !this._dirtyCameras) { // if dirty flags on comp are clean, check if they are not in layers
            for(i=0; i<len; i++) {
                layer = this.layerList[i];
                if (layer._dirty) {
                    this._dirty = true;
                }
                if (layer._dirtyLights) {
                    this._dirtyLights = true;
                }
                if (layer._dirtyCameras) {
                    this._dirtyCameras = true;
                }
            }
        }

        var arr;
        if (this._dirty) {
            result |= pc.COMPUPDATED_INSTANCES;
            this._meshInstances.length = 0;
            var mi;
            for(i=0; i<len; i++) {
                layer = this.layerList[i];
                if (layer.passThrough) continue;
                arr = layer.opaqueMeshInstances;
                for(j=0; j<arr.length; j++) {
                    mi = arr[j];
                    if (this._meshInstances.indexOf(mi) < 0) {
                        this._meshInstances.push(mi);
                        if (mi.material && mi.material._dirtyBlend) {
                            this._dirtyBlend = true;
                            mi.material._dirtyBlend = false;
                        }
                    }
                }
                arr = layer.transparentMeshInstances;
                for(j=0; j<arr.length; j++) {
                    mi = arr[j];
                    if (this._meshInstances.indexOf(mi) < 0) {
                        this._meshInstances.push(mi);
                        if (mi.material && mi.material._dirtyBlend) {
                            this._dirtyBlend = true;
                            mi.material._dirtyBlend = false;
                        }
                    }
                }
            }
            //this._dirty = false;
            for(i=0; i<len; i++) {
                this.layerList[i]._dirty = false;
                this.layerList[i]._version++;
            }
        }

        if (this._dirtyBlend) {
            // TODO: make it fast
            result |= pc.COMPUPDATED_BLEND;
            var opaqueOld, transparentOld, opaqueNew, transparentNew;
            for(i=0; i<len; i++) {
                layer = this.layerList[i];
                if (layer.passThrough) continue;
                opaqueOld = layer.opaqueMeshInstances;
                transparentOld = layer.transparentMeshInstances;
                opaqueNew = [];
                transparentNew = [];
                for(j=0; j<opaqueOld.length; j++) {
                    if (opaqueOld[j].material && opaqueOld[j].material.blendType !== pc.BLEND_NONE) {
                        transparentNew.push(opaqueOld[j]);
                    } else {
                        opaqueNew.push(opaqueOld[j]);
                    }
                }
                for(j=0; j<transparentOld.length; j++) {
                    if (transparentOld[j].material && transparentOld[j].material.blendType !== pc.BLEND_NONE) {
                        transparentNew.push(transparentOld[j]);
                    } else {
                        opaqueNew.push(transparentOld[j]);
                    }
                }
                layer.opaqueMeshInstances.length = opaqueNew.length;
                for(j=0; j<opaqueNew.length; j++) {
                    layer.opaqueMeshInstances[j] = opaqueNew[j];
                }
                layer.transparentMeshInstances.length = transparentNew.length;
                for(j=0; j<transparentNew.length; j++) {
                    layer.transparentMeshInstances[j] = transparentNew[j];
                }
            }
            this._dirtyBlend = false;
        }

        this._dirty = false;

        var transparent;
        if (this._dirtyLights || (result & pc.COMPUPDATED_INSTANCES)) {
            result |= pc.COMPUPDATED_LIGHTS;
            this._lights.length = 0;
            this._lightShadowCasters.length = 0;
            // TODO: don't create new arrays, reference
            // updates when _dirty as well to fix shadow casters
            var light, casters, meshInstances, lid;

            for(i=0; i<len; i++) {
                layer = this.layerList[i];
                arr = layer._lights;
                for(j=0; j<arr.length; j++) {
                    light = arr[j];
                    lid = this._lights.indexOf(light);
                    if (lid < 0) {
                        this._lights.push(light);
                        lid = this._lights.length - 1;
                    }

                    casters = this._lightShadowCasters[lid];
                    if (!casters) {
                        this._lightShadowCasters[lid] = casters = [];
                    }
                }
            }
        }

        if (this._dirtyLights) {
            this._sortLights(this);
            this._dirtyLights = false;

            for(i=0; i<len; i++) {
                layer = this.layerList[i];
                this._sortLights(layer);
                layer._dirtyLights = false;
            }
        }

        if (result) { // meshes OR lights changed
            for(i=0; i<len; i++) {
                layer = this.layerList[i];
                arr = layer._lights;
                for(j=0; j<arr.length; j++) {
                    light = arr[j];
                    lid = this._lights.indexOf(light);
                    casters = this._lightShadowCasters[lid];
                    meshInstances = layer.shadowCasters;
                    for(k=0; k<meshInstances.length; k++) {
                        if (casters.indexOf(meshInstances[k]) < 0) casters.push(meshInstances[k]);
                    }
                }
            }
        }

        if ((result & pc.COMPUPDATED_LIGHTS) || this._dirtyCameras) {
            // TODO: make dirty when changing layer.enabled on/off
            this._globalLightCameras.length = 0;
            var globalLights = this._sortedLights[pc.LIGHTTYPE_DIRECTIONAL];
            for(var l=0; l<globalLights.length; l++) {
                light = globalLights[l];
                this._globalLightCameras[l] = [];
                for(i=0; i<len; i++) {
                    layer = this.layerList[i];
                    if (layer._sortedLights[pc.LIGHTTYPE_DIRECTIONAL].indexOf(light) < 0) continue;
                    for(k=0; k<layer.cameras.length; k++) {
                        if (this._globalLightCameras[l].indexOf(layer.cameras[k]) >= 0) continue;
                        this._globalLightCameras[l].push(layer.cameras[k]);
                    }
                }
            }
        }

        var camera, index;
        if (this._dirtyCameras) {
            result |= pc.COMPUPDATED_CAMERAS;

            this.cameras.length = 0;
            for(i=0; i<len; i++) {
                layer = this.layerList[i];
                for(j=0; j<layer.cameras.length; j++) {
                    camera = layer.cameras[j];
                    index = this.cameras.indexOf(camera);
                    if (index < 0) {
                        index = this.cameras.length;
                        this.cameras.push(camera);
                    }
                }
            }

            this._renderList.length = 0;
            this._renderListCamera.length = 0;
            var hash, hash2, groupLength, cam;
            var skipCount = 0;

            for(i=0; i<len; i++) {
                if (skipCount) {
                    skipCount--;
                    continue;
                }

                layer = this.layerList[i];
                if (layer.cameras.length === 0 && !layer.isPostEffect) continue;
                hash = layer._cameraHash;
                if (hash === 0) { // single camera in layer
                    this._renderList.push(i);
                    this._renderListCamera.push(0);

                } else { // multiple cameras in a layer
                    groupLength = 1; // check if there is a sequence of sublayers with same cameras
                    for(j=i+1; j<len; j++) {
                        hash2 = this.layerList[j]._cameraHash;
                        if (hash !== hash2) {
                            groupLength = (j - i) - 1;
                            break;
                        } else if (j === len - 1) {
                            groupLength = j - i;
                        }
                    }
                    if (groupLength === 1) { // not a sequence, but multiple cameras
                        for(cam=0; cam<layer.cameras.length; cam++) {
                            this._renderList.push(i);
                            this._renderListCamera.push(cam);
                        }

                    } else { // sequence of groupLength
                        // add a whole sequence for each camera
                        cam = 0;
                        for(cam=0; cam<layer.cameras.length; cam++) {
                            for(j=0; j<=groupLength; j++) {
                                this._renderList.push(i + j);
                                this._renderListCamera.push(cam);
                            }
                        }
                        // skip the sequence sublayers (can't just modify i in JS)
                        skipCount = groupLength;
                    }
                }
            }

            this._dirtyCameras = false;
            for(i=0; i<len; i++) {
                this.layerList[i]._dirtyCameras = false;
            }
        }

        if ((result & pc.COMPUPDATED_LIGHTS) || (result & pc.COMPUPDATED_CAMERAS)) {
            // cameras/lights changed
            this._globalLightCameraIds.length = 0;
            for(var l=0; l<this._globalLightCameras.length; l++) {
                arr = [];
                for(i=0; i<this._globalLightCameras[l].length; i++) {
                    index = this.cameras.indexOf( this._globalLightCameras[l][i] );
                    if (index < 0) {
                        // #ifdef DEBUG
                        console.warn("Can't find _globalLightCameras[l][i] in cameras");
                        // #endif
                        continue;
                    }
                    arr.push(index);
                }
                this._globalLightCameraIds.push(arr);
            }
        }

        return result;
    };

    LayerComposition.prototype._isLayerAdded = function (layer) {
        if (this.layerList.indexOf(layer) >= 0) {
            // #ifdef DEBUG
            console.error("Layer is already added.");
            // #endif
            return true;
        }
        return false;
    };

    LayerComposition.prototype._isSublayerAdded = function (layer, transparent) {
        for(var i=0; i<this.layerList.length; i++) {
            if (this.layerList[i] === layer && this.subLayerList[i] === transparent) {
                // #ifdef DEBUG
                console.error("Sublayer is already added.");
                // #endif
                return true;
            }
        }
        return false;
    };

    // Whole layer API

    /**
     * @function
     * @name pc.LayerComposition#push
     * @description Adds a layer (both opaque and semi-transparent parts) to the end of the {@link pc.Layer#layerList}.
     * @param {pc.Layer} layer A {@link pc.Layer} to add.
     */
    LayerComposition.prototype.push = function (layer) {
        // add both opaque and transparent to the end of the array
        if (this._isLayerAdded(layer)) return;
        this.layerList.push(layer);
        this.layerList.push(layer);
        this.subLayerList.push(false);
        this.subLayerList.push(true);
        this.subLayerEnabled.push(true);
        this.subLayerEnabled.push(true);
        this._dirty = true;
        this._dirtyLights = true;
        this._dirtyCameras = true;
        this.fire("add", layer);
    };

    /**
     * @function
     * @name pc.LayerComposition#insert
     * @description Inserts a layer (both opaque and semi-transparent parts) at the chosen index in the {@link pc.Layer#layerList}.
     * @param {pc.Layer} layer A {@link pc.Layer} to add.
     * @param {Number} index Insertion position.
     */
    LayerComposition.prototype.insert = function (layer, index) {
        // insert both opaque and transparent at the index
        if (this._isLayerAdded(layer)) return;
        this.layerList.splice(index, 0,    layer,  layer);
        this.subLayerList.splice(index, 0, false,  true);
        this.subLayerEnabled.splice(index, 0, true,  true);
        this._dirty = true;
        this._dirtyLights = true;
        this._dirtyCameras = true;
        this.fire("add", layer);
    };

    /**
     * @function
     * @name pc.LayerComposition#remove
     * @description Removes a layer (both opaque and semi-transparent parts) from {@link pc.Layer#layerList}.
     * @param {pc.Layer} layer A {@link pc.Layer} to remove.
     */
    LayerComposition.prototype.remove = function (layer) {
        // remove all occurences of a layer
        var id = this.layerList.indexOf(layer);
        while(id >= 0) {
            this.layerList.splice(id, 1);
            this.subLayerList.splice(id, 1);
            this.subLayerEnabled.splice(id, 1);
            id = this.layerList.indexOf(layer);
            this._dirty = true;
            this._dirtyLights = true;
            this._dirtyCameras = true;
            this.fire("remove", layer);
        }
    };

    // Sublayer API

    /**
     * @function
     * @name pc.LayerComposition#pushOpaque
     * @description Adds part of the layer with opaque (non semi-transparent) objects to the end of the {@link pc.Layer#layerList}.
     * @param {pc.Layer} layer A {@link pc.Layer} to add.
     */
    LayerComposition.prototype.pushOpaque = function (layer) {
        // add opaque to the end of the array
        if (this._isSublayerAdded(layer, false)) return;
        this.layerList.push(layer);
        this.subLayerList.push(false);
        this.subLayerEnabled.push(true);
        this._dirty = true;
        this._dirtyLights = true;
        this._dirtyCameras = true;
        this.fire("add", layer);
    };

    /**
     * @function
     * @name pc.LayerComposition#insertOpaque
     * @description Inserts an opaque part of the layer (non semi-transparent mesh instances) at the chosen index in the {@link pc.Layer#layerList}.
     * @param {pc.Layer} layer A {@link pc.Layer} to add.
     * @param {Number} index Insertion position.
     */
    LayerComposition.prototype.insertOpaque = function (layer, index) {
        // insert opaque at index
        if (this._isSublayerAdded(layer, false)) return;
        this.layerList.splice(index, 0,    layer);
        this.subLayerList.splice(index, 0, false);
        this.subLayerEnabled.splice(index, 0, true);
        this._dirty = true;
        this._dirtyLights = true;
        this._dirtyCameras = true;
        this.fire("add", layer);
    };

    /**
     * @function
     * @name pc.LayerComposition#removeOpaque
     * @description Removes an opaque part of the layer (non semi-transparent mesh instances) from {@link pc.Layer#layerList}.
     * @param {pc.Layer} layer A {@link pc.Layer} to remove.
     */
    LayerComposition.prototype.removeOpaque = function (layer) {
        // remove opaque occurences of a layer
        for(var i=0; i<this.layerList.length; i++) {
            if (this.layerList[i] === layer && !this.subLayerList[i]) {
                this.layerList.splice(i, 1);
                this.subLayerList.splice(i, 1);
                this.subLayerEnabled.splice(i, 1);
                this._dirty = true;
                this._dirtyLights = true;
                this._dirtyCameras = true;
                if (this.layerList.indexOf(layer) < 0) {
                    this.fire("remove", layer); // no sublayers left
                }
                return;
            }
        }
    };

    /**
     * @function
     * @name pc.LayerComposition#pushTransparent
     * @description Adds part of the layer with semi-transparent objects to the end of the {@link pc.Layer#layerList}.
     * @param {pc.Layer} layer A {@link pc.Layer} to add.
     */
    LayerComposition.prototype.pushTransparent = function (layer) {
        // add transparent to the end of the array
        if (this._isSublayerAdded(layer, true)) return;
        this.layerList.push(layer);
        this.subLayerList.push(true);
        this.subLayerEnabled.push(true);
        this._dirty = true;
        this._dirtyLights = true;
        this._dirtyCameras = true;
        this.fire("add", layer);
    };

    /**
     * @function
     * @name pc.LayerComposition#insertTransparent
     * @description Inserts a semi-transparent part of the layer at the chosen index in the {@link pc.Layer#layerList}.
     * @param {pc.Layer} layer A {@link pc.Layer} to add.
     * @param {Number} index Insertion position.
     */
    LayerComposition.prototype.insertTransparent = function (layer, index) {
        // insert transparent at index
        if (this._isSublayerAdded(layer, true)) return;
        this.layerList.splice(index, 0,    layer);
        this.subLayerList.splice(index, 0, true);
        this.subLayerEnabled.splice(index, 0, true);
        this._dirty = true;
        this._dirtyLights = true;
        this._dirtyCameras = true;
        this.fire("add", layer);
    };

    /**
     * @function
     * @name pc.LayerComposition#removeTransparent
     * @description Removes a transparent part of the layer from {@link pc.Layer#layerList}.
     * @param {pc.Layer} layer A {@link pc.Layer} to remove.
     */
    LayerComposition.prototype.removeTransparent = function (layer) {
        // remove transparent occurences of a layer
        for(var i=0; i<this.layerList.length; i++) {
            if (this.layerList[i] === layer && this.subLayerList[i]) {
                this.layerList.splice(i, 1);
                this.subLayerList.splice(i, 1);
                this.subLayerEnabled.splice(i, 1);
                this._dirty = true;
                this._dirtyLights = true;
                this._dirtyCameras = true;
                if (this.layerList.indexOf(layer) < 0) {
                    this.fire("remove", layer); // no sublayers left
                }
                return;
            }
        }
    };

    LayerComposition.prototype._getSublayerIndex = function (layer, transparent) {
        // find sublayer index in the composition array
        var id = this.layerList.indexOf(layer);
        if (id < 0) return -1;

        if (this.subLayerList[id] !== transparent) {
            id = this.layerList.indexOf(layer, id + 1);
            if (id < 0) return -1;
            if (this.subLayerList[id] !== transparent) {
                return -1;
            }
        }
        return id;
    };

    /**
     * @function
     * @name pc.LayerComposition#getOpaqueIndex
     * @description Gets index of the opaque part of the supplied layer in the {@link pc.Layer#layerList}.
     * @param {pc.Layer} layer A {@link pc.Layer} to find index of.
     */
    LayerComposition.prototype.getOpaqueIndex = function (layer) {
        return this._getSublayerIndex(layer, false);
    };

    /**
     * @function
     * @name pc.LayerComposition#getTransparentIndex
     * @description Gets index of the semi-transparent part of the supplied layer in the {@link pc.Layer#layerList}.
     * @param {pc.Layer} layer A {@link pc.Layer} to find index of.
     */
    LayerComposition.prototype.getTransparentIndex = function (layer) {
        return this._getSublayerIndex(layer, true);
    };

    /**
     * @function
     * @name pc.LayerComposition#getLayerById
     * @description Finds a layer inside this composition by its ID. Null is returned, if nothing is found.
     * @param {Number} name An ID of the layer to find
     */
    LayerComposition.prototype.getLayerById = function (id) {
        for(var i=0; i<this.layerList.length; i++) {
            if (this.layerList[i].id === id) return this.layerList[i];
        }
        return null;
    };

    /**
     * @function
     * @name pc.LayerComposition#getLayerByName
     * @description Finds a layer inside this composition by its name. Null is returned, if nothing is found.
     * @param {String} name A name of the layer to find
     */
    LayerComposition.prototype.getLayerByName = function (name) {
        for(var i=0; i<this.layerList.length; i++) {
            if (this.layerList[i].name === name) return this.layerList[i];
        }
        return null;
    };

    return {
        LayerComposition: LayerComposition
    };
}());