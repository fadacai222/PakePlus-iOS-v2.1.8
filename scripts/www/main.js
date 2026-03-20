window.boot = function () {
    var settings = window._CCSettings;
    window._CCSettings = undefined;
    var onProgress = null;

    var RESOURCES = cc.AssetManager.BuiltinBundleName.RESOURCES;
    var INTERNAL = cc.AssetManager.BuiltinBundleName.INTERNAL;
    var MAIN = cc.AssetManager.BuiltinBundleName.MAIN;
    function applyMobileViewLayout () {
        if (!cc.sys.isMobile) {
            return;
        }

        var frameSize = cc.view.getFrameSize();
        var width = frameSize && frameSize.width ? frameSize.width : 1920;
        var height = frameSize && frameSize.height ? frameSize.height : 1080;
        var policy = width >= height ? cc.ResolutionPolicy.FIXED_HEIGHT : cc.ResolutionPolicy.SHOW_ALL;

        cc.view.setDesignResolutionSize(1920, 1080, policy);
    }

    function suppressLegacyPlaybackPrompt () {
        if (!cc.director || !cc.director.getScene) {
            return;
        }

        var scene = cc.director.getScene();
        if (!scene) {
            return;
        }

        var queue = [scene];
        while (queue.length) {
            var node = queue.shift();
            if (!node) {
                continue;
            }

            var components = node._components || [];
            for (var i = 0; i < components.length; i++) {
                var component = components[i];
                if (!component || !component.topTips || !component.topTips.node) {
                    continue;
                }

                try {
                    if (typeof component.unscheduleAllCallbacks === 'function') {
                        component.unscheduleAllCallbacks();
                    }
                } catch (err) {}

                component.topTips.string = '';
                component.topTips.node.opacity = 0;
                component.topTips.node.active = false;
            }

            var children = node.children || [];
            for (var j = 0; j < children.length; j++) {
                queue.push(children[j]);
            }
        }
    }

    function scheduleLegacyPlaybackPromptSuppression () {
        if (typeof window === 'undefined' || typeof window.setInterval !== 'function') {
            return;
        }

        var attempts = 0;
        var timer = window.setInterval(function () {
            attempts++;
            suppressLegacyPlaybackPrompt();
            if (attempts >= 300) {
                window.clearInterval(timer);
            }
        }, 100);
    }

    function setLoadingDisplay () {
        // Loading splash scene
        var splash = document.getElementById('splash');
        var progressBar = splash.querySelector('.progress-bar span');
        onProgress = function (finish, total) {
            var percent = 100 * finish / total;
            if (progressBar) {
                progressBar.style.width = percent.toFixed(2) + '%';
            }
        };
        splash.style.display = 'block';
        progressBar.style.width = '0%';

        cc.director.once(cc.Director.EVENT_AFTER_SCENE_LAUNCH, function () {
            splash.style.display = 'none';
            scheduleLegacyPlaybackPromptSuppression();
        });
    }

    var onStart = function () {

        cc.view.enableRetina(true);
        cc.view.resizeWithBrowserSize(true);
        applyMobileViewLayout();

        if (cc.sys.isBrowser) {
            setLoadingDisplay();
        }

        if (cc.sys.isMobile) {
            if (settings.orientation === 'landscape') {
                cc.view.setOrientation(cc.macro.ORIENTATION_LANDSCAPE);
            }
            else if (settings.orientation === 'portrait') {
                cc.view.setOrientation(cc.macro.ORIENTATION_PORTRAIT);
            }
            cc.view.enableAutoFullScreen([
                cc.sys.BROWSER_TYPE_BAIDU,
                cc.sys.BROWSER_TYPE_BAIDU_APP,
                cc.sys.BROWSER_TYPE_WECHAT,
                cc.sys.BROWSER_TYPE_MOBILE_QQ,
                cc.sys.BROWSER_TYPE_MIUI,
                cc.sys.BROWSER_TYPE_HUAWEI,
                cc.sys.BROWSER_TYPE_UC,
            ].indexOf(cc.sys.browserType) < 0);
        }

        if (cc.sys.isBrowser) {
            window.addEventListener('resize', applyMobileViewLayout);
        }

        // Limit downloading max concurrent task to 2,
        // more tasks simultaneously may cause performance draw back on some android system / browsers.
        // You can adjust the number based on your own test result, you have to set it before any loading process to take effect.
        if (cc.sys.isBrowser && cc.sys.os === cc.sys.OS_ANDROID) {
            cc.assetManager.downloader.maxConcurrency = 2;
            cc.assetManager.downloader.maxRequestsPerFrame = 2;
        }

        var launchScene = settings.launchScene;
        var bundle = cc.assetManager.bundles.find(function (b) {
            return b.getSceneInfo(launchScene);
        });

        bundle.loadScene(launchScene, null, onProgress,
            function (err, scene) {
                if (!err) {
                    cc.director.runSceneImmediate(scene);
                    applyMobileViewLayout();
                    if (cc.sys.isBrowser) {
                        // show canvas
                        var canvas = document.getElementById('GameCanvas');
                        canvas.style.visibility = '';
                        var div = document.getElementById('GameDiv');
                        if (div) {
                            div.style.backgroundImage = '';
                        }
                        console.log('Success to load scene: ' + launchScene);
                    }
                }
            }
        );

    };

    var option = {
        id: 'GameCanvas',
        debugMode: settings.debug ? cc.debug.DebugMode.INFO : cc.debug.DebugMode.ERROR,
        showFPS: settings.debug,
        frameRate: 60,
        groupList: settings.groupList,
        collisionMatrix: settings.collisionMatrix,
    };

    cc.assetManager.init({
        bundleVers: settings.bundleVers,
        remoteBundles: settings.remoteBundles,
        server: settings.server
    });

    var bundleRoot = [INTERNAL];
    settings.hasResourcesBundle && bundleRoot.push(RESOURCES);

    var count = 0;
    function cb (err) {
        if (err) return console.error(err.message, err.stack);
        count++;
        if (count === bundleRoot.length + 1) {
            cc.assetManager.loadBundle(MAIN, function (err) {
                if (!err) cc.game.run(option, onStart);
            });
        }
    }

    cc.assetManager.loadScript(settings.jsList.map(function (x) { return 'src/' + x;}), cb);

    for (var i = 0; i < bundleRoot.length; i++) {
        cc.assetManager.loadBundle(bundleRoot[i], cb);
    }
};

if (window.jsb) {
    var isRuntime = (typeof loadRuntime === 'function');
    if (isRuntime) {
        require('src/settings.js');
        require('src/cocos2d-runtime.js');
        if (CC_PHYSICS_BUILTIN || CC_PHYSICS_CANNON) {
            require('src/physics.js');
        }
        require('jsb-adapter/engine/index.js');
    }
    else {
        require('src/settings.js');
        require('src/cocos2d-jsb.js');
        if (CC_PHYSICS_BUILTIN || CC_PHYSICS_CANNON) {
            require('src/physics.js');
        }
        require('jsb-adapter/jsb-engine.js');
    }

    cc.macro.CLEANUP_IMAGE_CACHE = true;
    window.boot();
}
