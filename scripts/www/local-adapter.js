// 本地适配层 - 自动扫描 songs 目录并强制走本地资源
(function () {
  "use strict";

  var SONGS_ROOT = "./songs/";
  var ROOT_CHART_FALLBACKS = ["./song.json"];
  var ROOT_AUDIO_FALLBACKS = [
    "./song.mp3",
    "./music/song.mp3",
    "./audio/song.mp3",
  ];
  var EMPTY_CHART_DATA = {
    scoreInfo: { offset: 0 },
    bpms: [{ lineNo: 0, bpmVal: 120 }],
    boards: [{ lineDatas: [] }],
    players: [1],
  };

  var discoveredSongs = [];
  var currentSong = null;
  var currentSongPath = ROOT_CHART_FALLBACKS[0];
  var currentMusicPath = ROOT_AUDIO_FALLBACKS[0];
  var EMBEDDED_MANIFEST_SOURCE = "embedded-manifest";
  var MAX_DISCOVERY_CONCURRENCY = Math.max(
    4,
    Math.min(
      8,
      (window.navigator && window.navigator.hardwareConcurrency) || 6,
    ),
  );
  var SONG_SELECTOR_STORAGE_KEY = "singworld:last-song";
  var DEFAULT_SONG_SELECTOR_ROW_HEIGHT = 108;
  var songSelectorRowHeight = DEFAULT_SONG_SELECTOR_ROW_HEIGHT;
  var SONG_SELECTOR_OVERSCAN = 4;
  var selectionReadyResolve = function () {};
  var selectionReadySettled = false;
  var selectionReadyPromise = new Promise(function (resolve) {
    selectionReadyResolve = function (song) {
      if (selectionReadySettled) {
        return;
      }

      selectionReadySettled = true;
      resolve(song || currentSong || buildDefaultSong());
    };
  });
  var songSelectorState = {
    root: null,
    countValue: null,
    countLabel: null,
    status: null,
    scanMeta: null,
    listViewport: null,
    listSpacer: null,
    listItems: null,
    empty: null,
    previewCard: null,
    previewBg: null,
    previewCover: null,
    previewFallback: null,
    previewTitle: null,
    previewTags: null,
    startButton: null,
    pointerId: null,
    pointerSongKey: "",
    pointerStartX: 0,
    pointerStartY: 0,
    pointerStartScrollTop: 0,
    pointerMoved: false,
    requestedKey: "",
    storedKey: "",
    query: "",
    orderedSongs: [],
    filteredSongs: [],
    songsByKey: {},
    selectedSongKey: "",
    scanComplete: false,
    scanInProgress: false,
    totalDirectories: 0,
    scannedDirectories: 0,
    renderFrame: 0,
    requestedSongMissing: false,
  };
  var playerHudState = {
    root: null,
    backButton: null,
    title: null,
    elapsed: null,
    duration: null,
    progressFill: null,
    visible: false,
    renderFrame: 0,
    completionTicks: 0,
  };
  var currentAudioElement = null;
  var currentAudioEvents = null;
  var cachedPlaybackComponent = null;
  var returningToSongSelector = false;
  var playbackCompletionQueued = false;
  var previewAudioElement = null;
  var previewAudioEvents = null;
  var previewAudioSongKey = "";
  var previewAudioLoadingKey = "";
  var embeddedManifestSongsCache = null;
  var earlyLocalFileXHRPatched = false;
  var earlyLocalFetchPatched = false;
  var earlyLocalNativePatched = false;
  var localFileImagePipelinePatched = false;
  var embeddedNativeObjectUrlCache = {};
  var SONGS_DIRECTORY_DB_NAME = "singworld-player-db";
  var SONGS_DIRECTORY_DB_STORE = "handles";
  var SONGS_DIRECTORY_DB_KEY = "songs-root-directory";
  var pickedSongsDirectoryHandle = null;
  var pickedSongsDirectoryName = "";
  var pickedSongsDirectoryRestoreAttempted = false;
  var pickedSongsDirectoryRestorePromise = null;
  var pickedSongsObjectUrls = [];
  var songLibrarySourceMode = "auto";
  var songLibrarySourceLabel = "";
  var songLibraryStatusMessage = "";

  function getBasePageUrl() {
    return window.location.href.split("#")[0].split("?")[0];
  }

  function supportsSongsDirectoryPicker() {
    return !!(window && typeof window.showDirectoryPicker === "function");
  }

  function joinSongRelativePath(basePath, name) {
    if (!basePath) {
      return name || "";
    }
    if (!name) {
      return basePath;
    }
    return stripTrailingSlash(basePath) + "/" + name;
  }

  function createPickedVirtualPath(relativePath, fileName) {
    var parts = [];
    if (relativePath) {
      parts.push(relativePath);
    }
    if (fileName) {
      parts.push(fileName);
    }
    return "picked://songs/" + parts.join("/");
  }

  function openSongsDirectoryDatabase() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB unavailable"));
        return;
      }

      var request = indexedDB.open(SONGS_DIRECTORY_DB_NAME, 1);

      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains(SONGS_DIRECTORY_DB_STORE)) {
          database.createObjectStore(SONGS_DIRECTORY_DB_STORE);
        }
      };

      request.onsuccess = function () {
        resolve(request.result);
      };

      request.onerror = function () {
        reject(request.error || new Error("Failed to open IndexedDB"));
      };
    });
  }

  function saveSongsDirectoryHandle(handle) {
    if (!handle || typeof indexedDB === "undefined") {
      return Promise.resolve(false);
    }

    return openSongsDirectoryDatabase()
      .then(function (database) {
        return new Promise(function (resolve, reject) {
          var transaction = database.transaction(SONGS_DIRECTORY_DB_STORE, "readwrite");
          var store = transaction.objectStore(SONGS_DIRECTORY_DB_STORE);
          var request = store.put(handle, SONGS_DIRECTORY_DB_KEY);

          transaction.oncomplete = function () {
            database.close();
            resolve(true);
          };
          transaction.onerror = function () {
            database.close();
            reject(transaction.error || request.error || new Error("Failed to save directory handle"));
          };
          request.onerror = function () {
            reject(request.error || new Error("Failed to save directory handle"));
          };
        });
      })
      .catch(function (err) {
        console.warn("Failed to persist songs directory handle:", err);
        return false;
      });
  }

  function loadSavedSongsDirectoryHandle() {
    if (typeof indexedDB === "undefined") {
      return Promise.resolve(null);
    }

    return openSongsDirectoryDatabase()
      .then(function (database) {
        return new Promise(function (resolve, reject) {
          var transaction = database.transaction(SONGS_DIRECTORY_DB_STORE, "readonly");
          var store = transaction.objectStore(SONGS_DIRECTORY_DB_STORE);
          var request = store.get(SONGS_DIRECTORY_DB_KEY);

          request.onsuccess = function () {
            resolve(request.result || null);
          };
          request.onerror = function () {
            reject(request.error || new Error("Failed to load directory handle"));
          };
          transaction.oncomplete = function () {
            database.close();
          };
        });
      })
      .catch(function (err) {
        console.warn("Failed to restore songs directory handle:", err);
        return null;
      });
  }

  function clearSavedSongsDirectoryHandle() {
    if (typeof indexedDB === "undefined") {
      return Promise.resolve(false);
    }

    return openSongsDirectoryDatabase()
      .then(function (database) {
        return new Promise(function (resolve, reject) {
          var transaction = database.transaction(SONGS_DIRECTORY_DB_STORE, "readwrite");
          var store = transaction.objectStore(SONGS_DIRECTORY_DB_STORE);
          var request = store.delete(SONGS_DIRECTORY_DB_KEY);

          transaction.oncomplete = function () {
            database.close();
            resolve(true);
          };
          transaction.onerror = function () {
            database.close();
            reject(transaction.error || request.error || new Error("Failed to clear directory handle"));
          };
          request.onerror = function () {
            reject(request.error || new Error("Failed to clear directory handle"));
          };
        });
      })
      .catch(function (err) {
        console.warn("Failed to clear saved songs directory handle:", err);
        return false;
      });
  }

  function querySongsDirectoryPermission(handle) {
    if (!handle || typeof handle.queryPermission !== "function") {
      return Promise.resolve("unsupported");
    }

    try {
      return Promise.resolve(handle.queryPermission({ mode: "read" })).catch(function () {
        return "prompt";
      });
    } catch (err) {
      return Promise.resolve("prompt");
    }
  }

  function requestSongsDirectoryPermission(handle) {
    if (!handle || typeof handle.requestPermission !== "function") {
      return Promise.resolve(false);
    }

    try {
      return Promise.resolve(handle.requestPermission({ mode: "read" }))
        .then(function (result) {
          return result === "granted";
        })
        .catch(function () {
          return false;
        });
    } catch (err) {
      return Promise.resolve(false);
    }
  }

  function ensureSongsDirectoryReadable(handle, interactive) {
    if (!handle) {
      return Promise.resolve(false);
    }

    return querySongsDirectoryPermission(handle).then(function (permission) {
      if (permission === "granted") {
        return true;
      }
      if (!interactive) {
        return false;
      }
      return requestSongsDirectoryPermission(handle);
    });
  }

  function setPickedSongsDirectoryHandle(handle) {
    pickedSongsDirectoryHandle = handle || null;
    pickedSongsDirectoryName = handle && handle.name ? handle.name : "";
  }

  function restorePickedSongsDirectoryHandle() {
    if (!supportsSongsDirectoryPicker()) {
      return Promise.resolve(null);
    }

    if (pickedSongsDirectoryHandle) {
      return Promise.resolve(pickedSongsDirectoryHandle);
    }

    if (pickedSongsDirectoryRestorePromise) {
      return pickedSongsDirectoryRestorePromise;
    }

    if (pickedSongsDirectoryRestoreAttempted) {
      return Promise.resolve(null);
    }

    pickedSongsDirectoryRestoreAttempted = true;
    pickedSongsDirectoryRestorePromise = loadSavedSongsDirectoryHandle()
      .then(function (handle) {
        if (!handle) {
          return null;
        }

        return ensureSongsDirectoryReadable(handle, false).then(function (readable) {
          if (!readable) {
            return null;
          }
          setPickedSongsDirectoryHandle(handle);
          return handle;
        });
      })
      .catch(function (err) {
        console.warn("Failed to auto-restore songs directory handle:", err);
        return null;
      })
      .then(function (result) {
        pickedSongsDirectoryRestorePromise = null;
        return result;
      });

    return pickedSongsDirectoryRestorePromise;
  }

  function rememberPickedSongObjectUrl(url) {
    if (url) {
      pickedSongsObjectUrls.push(url);
    }
    return url;
  }

  function revokePickedSongObjectUrls() {
    for (var i = 0; i < pickedSongsObjectUrls.length; i++) {
      try {
        URL.revokeObjectURL(pickedSongsObjectUrls[i]);
      } catch (err) {}
    }
    pickedSongsObjectUrls.length = 0;
  }

  function readEntriesFromDirectoryHandle(directoryHandle) {
    return new Promise(function (resolve, reject) {
      if (!directoryHandle || typeof directoryHandle.values !== "function") {
        reject(new Error("Directory handle does not support values()"));
        return;
      }

      var iterator;
      try {
        iterator = directoryHandle.values();
      } catch (err) {
        reject(err);
        return;
      }

      var entries = [];

      function step() {
        iterator.next().then(function (result) {
          if (result.done) {
            resolve(entries);
            return;
          }

          var entry = result.value;
          if (entry && entry.name && entry.name.charAt(0) !== ".") {
            entries.push({
              name: entry.name,
              kind: entry.kind,
              handle: entry,
              isDirectory: entry.kind === "directory",
              href: entry.name,
            });
          }

          step();
        }).catch(reject);
      }

      step();
    });
  }

  function collectSongDirectoryNodes(directoryHandle, relativePath) {
    return readEntriesFromDirectoryHandle(directoryHandle).then(function (entries) {
      var pathParts = relativePath ? relativePath.split("/") : [];
      var node = {
        handle: directoryHandle,
        relativePath: relativePath || "",
        displayName: relativePath
          ? pathParts[pathParts.length - 1]
          : directoryHandle.name || "songs",
        entries: entries,
      };

      var nodes = [node];
      var task = Promise.resolve();

      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isDirectory || !entries[i].handle) {
          continue;
        }

        (function (entry) {
          task = task.then(function () {
            return collectSongDirectoryNodes(
              entry.handle,
              joinSongRelativePath(relativePath, entry.name),
            ).then(function (childNodes) {
              nodes = nodes.concat(childNodes);
            });
          });
        })(entries[i]);
      }

      return task.then(function () {
        return nodes;
      });
    });
  }

  function readJsonFromFileHandle(fileHandle) {
    if (!fileHandle || typeof fileHandle.getFile !== "function") {
      return Promise.reject(new Error("Invalid chart file handle"));
    }

    return fileHandle.getFile().then(function (file) {
      return file.text().then(function (text) {
        return JSON.parse(String(text || "").replace(/^\ufeff/, ""));
      });
    });
  }

  function createObjectUrlFromFileHandle(fileHandle) {
    if (!fileHandle || typeof fileHandle.getFile !== "function") {
      return Promise.reject(new Error("Invalid file handle"));
    }

    return fileHandle.getFile().then(function (file) {
      return rememberPickedSongObjectUrl(URL.createObjectURL(file));
    });
  }

  function buildSongFromHandleNode(node, source) {
    if (!node || !node.entries || !node.entries.length) {
      return Promise.resolve(null);
    }

    var chartFiles = [];
    var audioFiles = [];
    var imageFiles = [];

    for (var i = 0; i < node.entries.length; i++) {
      var entry = node.entries[i];
      if (!entry || entry.isDirectory) {
        continue;
      }
      if (isJsonFile(entry.name)) {
        chartFiles.push(entry);
      } else if (isAudioFile(entry.name)) {
        audioFiles.push(entry);
      } else if (isImageFile(entry.name)) {
        imageFiles.push(entry);
      }
    }

    var displayName = node.displayName || node.relativePath || "songs";
    var pair = chooseBestMediaPair(displayName, chartFiles, audioFiles);
    if (!pair) {
      return Promise.resolve(null);
    }

    var cover = chooseBestCover(displayName, imageFiles, pair);
    var aliases = buildSongAliases(displayName, pair);
    if (node.relativePath) {
      aliases.push(node.relativePath);
    }

    return Promise.all([
      readJsonFromFileHandle(pair.chart.handle),
      createObjectUrlFromFileHandle(pair.audio.handle),
      cover ? createObjectUrlFromFileHandle(cover.handle) : Promise.resolve(null),
    ]).then(function (results) {
      var chartData = results[0];
      var audioUrl = results[1];
      var coverUrl = results[2];
      var relativePath = node.relativePath || displayName;
      return {
        id: relativePath,
        title: stripExtension(pair.audio.name || pair.chart.name || displayName),
        dirName: relativePath,
        chartPath: createPickedVirtualPath(relativePath, pair.chart.name),
        audioPath: audioUrl,
        coverPath: coverUrl,
        aliases: aliases,
        source: source,
        chartData: chartData,
        persistentKey: createPickedVirtualPath(relativePath, pair.chart.name),
      };
    });
  }

  function discoverSongsFromPickedDirectory(options) {
    options = options || {};

    if (!pickedSongsDirectoryHandle) {
      return Promise.resolve([]);
    }

    songLibrarySourceMode = "picked-directory";
    songLibrarySourceLabel = pickedSongsDirectoryName || pickedSongsDirectoryHandle.name || "songs";

    return collectSongDirectoryNodes(pickedSongsDirectoryHandle, "")
      .then(function (nodes) {
        var songs = [];
        var totalDirectories = nodes.length;
        var scannedDirectories = 0;
        var task = Promise.resolve();

        if (options.onStatus) {
          options.onStatus({
            totalDirectories: totalDirectories,
            scannedDirectories: scannedDirectories,
            songCount: songs.length,
            scanComplete: totalDirectories === 0,
          });
        }

        for (var i = 0; i < nodes.length; i++) {
          (function (node) {
            task = task.then(function () {
              return buildSongFromHandleNode(node, "picked-directory")
                .catch(function (err) {
                  console.warn("Failed to analyze picked song directory:", node.relativePath || node.displayName, err);
                  return null;
                })
                .then(function (song) {
                  scannedDirectories++;
                  if (song) {
                    songs.push(song);
                    if (options.onSong) {
                      options.onSong(song);
                    }
                  }
                  if (options.onStatus) {
                    options.onStatus({
                      totalDirectories: totalDirectories,
                      scannedDirectories: scannedDirectories,
                      songCount: songs.length,
                      scanComplete: scannedDirectories >= totalDirectories,
                    });
                  }
                });
            });
          })(nodes[i]);
        }

        return task.then(function () {
          return songs;
        });
      })
      .catch(function (err) {
        console.warn("Failed to scan picked songs directory:", err);
        if (options.onStatus) {
          options.onStatus({
            totalDirectories: 0,
            scannedDirectories: 0,
            songCount: 0,
            scanComplete: true,
          });
        }
        throw err;
      });
  }

  function clearSongSelectorSongs() {
    stopSongPreview();
    revokePickedSongObjectUrls();
    discoveredSongs = [];
    songSelectorState.orderedSongs = [];
    songSelectorState.filteredSongs = [];
    songSelectorState.songsByKey = {};
    songSelectorState.selectedSongKey = "";
    songSelectorState.totalDirectories = 0;
    songSelectorState.scannedDirectories = 0;
    songSelectorState.requestedSongMissing = false;
    if (songSelectorState.listItems) {
      songSelectorState.listItems.innerHTML = "";
    }
    if (songSelectorState.listSpacer) {
      songSelectorState.listSpacer.style.height = "0px";
    }
    if (songSelectorState.empty) {
      songSelectorState.empty.hidden = true;
    }
  }

  function refreshSongSelectorButtons() {
    if (songSelectorState.chooseDirButton) {
      songSelectorState.chooseDirButton.disabled =
        songSelectorState.scanInProgress || !supportsSongsDirectoryPicker();
    }
    if (songSelectorState.refreshButton) {
      songSelectorState.refreshButton.disabled = songSelectorState.scanInProgress;
    }
  }

  function buildSongSelectorStatusText() {
    var parts = [];
    if (songSelectorState.scanInProgress) {
      if (songLibrarySourceMode === "picked-directory") {
        parts.push("正在扫描外部 songs 目录");
      } else if (songLibrarySourceMode === EMBEDDED_MANIFEST_SOURCE) {
        parts.push("正在加载内置曲库");
      } else {
        parts.push("正在扫描曲库");
      }
    }

    if (songLibrarySourceMode === "picked-directory") {
      parts.push("来源：外部目录" + (songLibrarySourceLabel ? "（" + songLibrarySourceLabel + "）" : ""));
    } else if (songLibrarySourceMode === EMBEDDED_MANIFEST_SOURCE) {
      parts.push("来源：内置曲库");
    } else if (songLibrarySourceMode === "songs-directory") {
      parts.push("来源：站点 songs 目录");
    } else if (songLibrarySourceMode === "root-default") {
      parts.push("来源：默认回退资源");
    }

    if (songSelectorState.scanMeta && songSelectorState.scanInProgress) {
      parts.push(
        "进度：" +
          (songSelectorState.scanMeta.scannedDirectories || 0) +
          "/" +
          (songSelectorState.scanMeta.totalDirectories || 0),
      );
    }

    if (songLibraryStatusMessage) {
      parts.push(songLibraryStatusMessage);
    }

    if (!supportsSongsDirectoryPicker()) {
      parts.push("当前浏览器不支持选择本地目录");
    }

    return parts.join(" ｜ ");
  }

  function startSongsDirectoryPickerFlow() {
    if (!supportsSongsDirectoryPicker()) {
      songLibraryStatusMessage = "当前浏览器不支持选择本地目录";
      updateSongSelectorStatus();
      return Promise.resolve(false);
    }

    if (songSelectorState.scanInProgress) {
      return Promise.resolve(false);
    }

    return Promise.resolve()
      .then(function () {
        return window.showDirectoryPicker({ id: "singworld-songs", mode: "read" });
      })
      .then(function (handle) {
        if (!handle) {
          return false;
        }

        setPickedSongsDirectoryHandle(handle);
        songLibraryStatusMessage = "已选择外部 songs 目录";
        pickedSongsDirectoryRestoreAttempted = true;
        return saveSongsDirectoryHandle(handle).then(function () {
          return rerunSongSelectionFlow({ keepCurrentSelection: false });
        });
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") {
          return false;
        }
        console.warn("Failed to select songs directory:", err);
        songLibraryStatusMessage = "选择 songs 目录失败";
        updateSongSelectorStatus();
        return false;
      });
  }

  function rerunSongSelectionFlow(options) {
    options = options || {};
    ensureSongSelectorUI();
    stopSongPreview();

    if (options.keepCurrentSelection && songSelectorState.selectedSongKey) {
      songSelectorState.storedKey = songSelectorState.selectedSongKey;
    } else {
      songSelectorState.storedKey = readStoredSongKey();
    }

    if (!options.preserveQuery) {
      songSelectorState.query = "";
    }

    clearSongSelectorSongs();
    songSelectorState.scanMeta = {
      totalDirectories: 0,
      scannedDirectories: 0,
      songCount: 0,
      scanComplete: false,
    };
    songSelectorState.scanComplete = false;
    songSelectorState.scanInProgress = true;
    updateSongSelectorCounts();
    updateSongSelectorStatus();
    updateSongPreview();
    scheduleSongListRender();

    return discoverSongsFromSongsDir({
      concurrency: MAX_DISCOVERY_CONCURRENCY,
      onSong: function (song) {
        addSongToSelector(song);
      },
      onStatus: function (status) {
        songSelectorState.scanMeta = {
          totalDirectories: status.totalDirectories || 0,
          scannedDirectories: status.scannedDirectories || 0,
          songCount: status.songCount || 0,
          scanComplete: !!status.scanComplete,
        };
        songSelectorState.totalDirectories = songSelectorState.scanMeta.totalDirectories;
        songSelectorState.scannedDirectories = songSelectorState.scanMeta.scannedDirectories;
        songSelectorState.scanInProgress = !songSelectorState.scanMeta.scanComplete;
        updateSongSelectorCounts();
        updateSongSelectorStatus();
        scheduleSongListRender();
      },
    })
      .then(function () {
        songSelectorState.scanInProgress = false;
        songSelectorState.scanComplete = true;
        if (songSelectorState.scanMeta) {
          songSelectorState.scanMeta.scanComplete = true;
        }

        if (!songSelectorState.orderedSongs.length) {
          songLibrarySourceMode = "root-default";
          songLibrarySourceLabel = "";
          if (!songLibraryStatusMessage) {
            songLibraryStatusMessage = "未发现可播放歌曲，已使用默认回退资源";
          }
          addSongToSelector(buildDefaultSong());
        }

        if (!songSelectorState.selectedSongKey && songSelectorState.orderedSongs.length) {
          var preferredSong =
            chooseRequestedSong(songSelectorState.orderedSongs, songSelectorState.requestedKey) ||
            chooseRequestedSong(songSelectorState.orderedSongs, songSelectorState.storedKey) ||
            songSelectorState.orderedSongs[0];
          songSelectorState.selectedSongKey = preferredSong._selectorKey;
        }

        applySongFilter(false);
        updateSongSelectorStatus();
        return songSelectorState.orderedSongs.slice();
      })
      .catch(function (err) {
        console.warn("Song selection flow failed, using root fallback:", err);
        songSelectorState.scanInProgress = false;
        songSelectorState.scanComplete = true;
        if (songSelectorState.scanMeta) {
          songSelectorState.scanMeta.scanComplete = true;
        }

        clearSongSelectorSongs();
        songLibrarySourceMode = "root-default";
        songLibrarySourceLabel = "";
        songLibraryStatusMessage = "曲库扫描失败，已使用默认回退资源";
        addSongToSelector(buildDefaultSong());
        applySongFilter(false);
        updateSongSelectorStatus();
        return songSelectorState.orderedSongs.slice();
      });
  }

  function isLocalFileProtocol() {
    return (
      typeof window !== "undefined" &&
      window.location &&
      window.location.protocol === "file:"
    );
  }

  function isAndroidAssetRuntime() {
    if (typeof window === "undefined" || !window.location) {
      return false;
    }

    var hostname = String(window.location.hostname || "").toLowerCase();
    var pathname = String(window.location.pathname || "").toLowerCase();

    return (
      hostname === "appassets.androidplatform.net" ||
      pathname.indexOf("/android_asset/") !== -1 ||
      pathname.indexOf("/android_res/") !== -1
    );
  }

  function preferDomImagePipelineForLocalFile() {
    if (
      localFileImagePipelinePatched ||
      !isLocalFileProtocol() ||
      typeof cc === "undefined" ||
      !cc.macro ||
      !cc.assetManager ||
      !cc.assetManager.downloader
    ) {
      return;
    }

    var downloader = cc.assetManager.downloader;
    var domImageDownloader = downloader.downloadDomImage;
    function embeddedImageDownloader(url, options, onComplete) {
      var runtimeUrl = getEmbeddedLocalNativeAssetUrl(url);
      if (!runtimeUrl) {
        if (typeof domImageDownloader === "function") {
          return domImageDownloader(url, options, onComplete);
        }
        if (onComplete) {
          onComplete(new Error("Missing embedded native asset: " + url));
        }
        return null;
      }

      var image = new Image();
      function cleanup() {
        image.removeEventListener("load", handleLoad);
        image.removeEventListener("error", handleError);
      }
      function handleLoad() {
        cleanup();
        if (onComplete) {
          onComplete(null, image);
        }
      }
      function handleError() {
        cleanup();
        if (typeof domImageDownloader === "function") {
          domImageDownloader(url, options, onComplete);
          return;
        }
        if (onComplete) {
          onComplete(new Error("Failed to load embedded native asset: " + url));
        }
      }

      image.addEventListener("load", handleLoad);
      image.addEventListener("error", handleError);
      image.src = runtimeUrl;
      return image;
    }

    cc.macro.ALLOW_IMAGE_BITMAP = false;

    if (typeof domImageDownloader === "function") {
      downloader.downloadDomImage = embeddedImageDownloader;
      downloader.register({
        ".png": embeddedImageDownloader,
        ".jpg": embeddedImageDownloader,
        ".jpeg": embeddedImageDownloader,
        ".bmp": embeddedImageDownloader,
        ".gif": embeddedImageDownloader,
        ".webp": embeddedImageDownloader,
        ".ico": embeddedImageDownloader,
        ".svg": embeddedImageDownloader,
        ".tiff": embeddedImageDownloader,
        ".image": embeddedImageDownloader,
      });
    }

    localFileImagePipelinePatched = true;
    console.log("Enabled static file image pipeline for file:// startup");
  }

  function formatTimeLabel(totalSeconds) {
    var safeSeconds = Math.max(0, Math.floor(totalSeconds || 0));
    var minutes = Math.floor(safeSeconds / 60);
    var seconds = safeSeconds % 60;
    return minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
  }

  function isSuccessfulLocalFileRequest(xhr, requestUrl) {
    if (!xhr || window.location.protocol !== "file:" || xhr.readyState !== 4) {
      return false;
    }

    var targetUrl = requestUrl || xhr._url || "";
    if (/^[a-z]+:/i.test(targetUrl) && !/^file:/i.test(targetUrl)) {
      return false;
    }

    try {
      if (xhr.responseType === "json" && xhr.response) {
        return true;
      }
    } catch (err) {}

    try {
      if (typeof xhr.response === "string" && xhr.response.length) {
        return true;
      }

      if (xhr.response && typeof xhr.response.byteLength === "number") {
        return xhr.response.byteLength > 0;
      }

      if (xhr.response && typeof xhr.response.size === "number") {
        return xhr.response.size > 0;
      }

      if (xhr.response && typeof xhr.response === "object") {
        return true;
      }
    } catch (err) {}

    try {
      return !!(xhr.responseText && xhr.responseText.length);
    } catch (err) {
      return false;
    }
  }

  function isSuccessfulRequestStatus(xhr, requestUrl) {
    var status = 0;
    try {
      status = xhr.status;
    } catch (err) {}

    return (
      status === 200 ||
      status === 204 ||
      (status === 0 && isSuccessfulLocalFileRequest(xhr, requestUrl))
    );
  }

  function loadTextFromPath(path) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", path, true);
      xhr.responseType = "text";

      xhr.onload = function () {
        if (!isSuccessfulRequestStatus(xhr, path)) {
          reject(
            new Error(
              "Failed to load text from: " + path + " status=" + xhr.status,
            ),
          );
          return;
        }

        var text = "";
        try {
          text =
            typeof xhr.response === "string"
              ? xhr.response
              : xhr.responseText || "";
        } catch (err) {
          text = "";
        }

        resolve(text);
      };

      xhr.onerror = function () {
        reject(new Error("XHR error loading text from: " + path));
      };

      xhr.send();
    });
  }

  function normalizeLocalAssetRequestUrl(url) {
    var value = String(url || "")
      .split("#")[0]
      .split("?")[0]
      .replace(/\\/g, "/");

    try {
      value = decodeURIComponent(value);
    } catch (err) {}

    if (/^file:/i.test(value)) {
      value = value.replace(/^file:\/*/i, "");
    }

    var compareValue = value.replace(/^\/+/, "");
    var baseDir = "";

    try {
      baseDir = decodeURIComponent(window.location.pathname || "")
        .replace(/\\/g, "/")
        .replace(/\/[^\/]*$/, "/")
        .replace(/^\/+/, "");
    } catch (err) {
      baseDir = "";
    }

    if (baseDir && compareValue.indexOf(baseDir) === 0) {
      compareValue = compareValue.slice(baseDir.length);
    }

    compareValue = compareValue.replace(/^\.\//, "").replace(/^\/+/, "");

    var assetsIndex = compareValue.toLowerCase().indexOf("assets/");
    if (assetsIndex >= 0) {
      compareValue = compareValue.slice(assetsIndex);
    }

    return compareValue;
  }

  function getEmbeddedLocalJsonText(requestUrl) {
    var store = window.__LOCAL_ASSET_JSON__;
    if (!store) {
      return null;
    }

    var normalizedUrl = normalizeLocalAssetRequestUrl(requestUrl);
    if (
      normalizedUrl &&
      Object.prototype.hasOwnProperty.call(store, normalizedUrl)
    ) {
      var entry = store[normalizedUrl];
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object") {
        if (typeof entry.value === "string") {
          return entry.value;
        }
        if (typeof entry.text === "string") {
          return entry.text;
        }
      }
    }

    return null;
  }

  function getEmbeddedLocalNativeAssetUrl(requestUrl) {
    var store = window.__LOCAL_ASSET_NATIVE__;
    if (!store) {
      return null;
    }

    var normalizedUrl = normalizeLocalAssetRequestUrl(requestUrl);
    if (
      normalizedUrl &&
      Object.prototype.hasOwnProperty.call(store, normalizedUrl)
    ) {
      var entry = store[normalizedUrl];
      var value = null;
      if (typeof entry === "string") {
        value = entry;
      } else if (entry && typeof entry === "object") {
        if (typeof entry.value === "string") {
          value = entry.value;
        } else if (typeof entry.url === "string") {
          value = entry.url;
        }
      }

      if (typeof value === "string" && /^data:/i.test(value)) {
        if (embeddedNativeObjectUrlCache[value]) {
          return embeddedNativeObjectUrlCache[value];
        }

        try {
          var commaIndex = value.indexOf(",");
          var meta = value.slice(5, commaIndex);
          var body = value.slice(commaIndex + 1);
          var isBase64 = /;base64/i.test(meta);
          var mimeType = meta.split(";")[0] || "application/octet-stream";
          var binaryString = isBase64 ? atob(body) : decodeURIComponent(body);
          var bytes = new Uint8Array(binaryString.length);

          for (var i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }

          value = URL.createObjectURL(
            new Blob([bytes], { type: mimeType || "application/octet-stream" }),
          );
          embeddedNativeObjectUrlCache[
            typeof entry === "string" ? entry : entry.value || entry.url
          ] = value;
        } catch (err) {}
      }

      if (typeof value === "string") {
        return value;
      }
    }

    return null;
  }

  function installEarlyLocalNativeAssetPatch() {
    if (
      earlyLocalNativePatched ||
      typeof window === "undefined" ||
      typeof HTMLImageElement === "undefined"
    ) {
      return;
    }

    if (isLocalFileProtocol()) {
      earlyLocalNativePatched = true;
      return;
    }

    var srcDescriptor = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "src",
    );

    if (!srcDescriptor || typeof srcDescriptor.set !== "function") {
      return;
    }

    function resolveImageSrc(value) {
      var embeddedUrl = getEmbeddedLocalNativeAssetUrl(value);
      return embeddedUrl || value;
    }

    try {
      Object.defineProperty(HTMLImageElement.prototype, "src", {
        configurable: true,
        enumerable: srcDescriptor.enumerable,
        get: function () {
          return srcDescriptor.get
            ? srcDescriptor.get.call(this)
            : this.getAttribute("src") || "";
        },
        set: function (value) {
          return srcDescriptor.set.call(this, resolveImageSrc(value));
        },
      });
    } catch (err) {
      return;
    }

    var originalSetAttribute = HTMLImageElement.prototype.setAttribute;
    HTMLImageElement.prototype.setAttribute = function (name, value) {
      if (String(name || "").toLowerCase() === "src") {
        value = resolveImageSrc(value);
      }
      return originalSetAttribute.call(this, name, value);
    };

    earlyLocalNativePatched = true;
  }

  function clampSongListScroll() {
    if (!songSelectorState.listViewport) {
      return;
    }

    var viewport = songSelectorState.listViewport;
    var maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);

    if (viewport.scrollTop > maxScrollTop) {
      viewport.scrollTop = maxScrollTop;
    }
  }

  function installEarlyLocalFileXHRPatch() {
    if (
      earlyLocalFileXHRPatched ||
      typeof window === "undefined" ||
      typeof window.XMLHttpRequest !== "function"
    ) {
      return;
    }

    var OriginalXHR = window.XMLHttpRequest;
    if (OriginalXHR.__localFileStatusPatch) {
      earlyLocalFileXHRPatched = true;
      return;
    }

    var originalStatusDescriptor = Object.getOwnPropertyDescriptor(
      OriginalXHR.prototype,
      "status",
    );
    var originalStatusTextDescriptor = Object.getOwnPropertyDescriptor(
      OriginalXHR.prototype,
      "statusText",
    );

    function LocalFilePatchedXHR() {
      var xhr = new OriginalXHR();
      var originalOpen = xhr.open;
      var originalSend = xhr.send;

      try {
        Object.defineProperty(xhr, "status", {
          configurable: true,
          get: function () {
            var status =
              originalStatusDescriptor && originalStatusDescriptor.get
                ? originalStatusDescriptor.get.call(this)
                : 0;

            if (status === 0 && isSuccessfulLocalFileRequest(this)) {
              return 200;
            }

            return status;
          },
        });

        Object.defineProperty(xhr, "statusText", {
          configurable: true,
          get: function () {
            if (this.status === 200 && window.location.protocol === "file:") {
              return "OK";
            }

            return originalStatusTextDescriptor &&
              originalStatusTextDescriptor.get
              ? originalStatusTextDescriptor.get.call(this)
              : "";
          },
        });
      } catch (err) {}

      xhr.open = function (method, url, async, user, password) {
        this._url = url;
        return originalOpen.apply(this, arguments);
      };

      xhr.send = function (body) {
        var embeddedJsonText = getEmbeddedLocalJsonText(this._url);
        if (embeddedJsonText !== null) {
          var responseType = xhr.responseType || "";
          setTimeout(function () {
            var responseValue = embeddedJsonText;
            if (responseType === "json") {
              try {
                responseValue = JSON.parse(embeddedJsonText);
              } catch (err) {
                responseValue = null;
              }
            }

            Object.defineProperty(xhr, "responseText", {
              configurable: true,
              get: function () {
                return embeddedJsonText;
              },
              set: function () {},
            });
            Object.defineProperty(xhr, "response", {
              configurable: true,
              get: function () {
                return responseValue;
              },
              set: function () {},
            });
            Object.defineProperty(xhr, "status", {
              configurable: true,
              get: function () {
                return 200;
              },
              set: function () {},
            });
            Object.defineProperty(xhr, "readyState", {
              configurable: true,
              get: function () {
                return 4;
              },
              set: function () {},
            });

            if (xhr.onreadystatechange) {
              xhr.onreadystatechange();
            }
            if (xhr.onload) {
              xhr.onload();
            }
            if (xhr.onloadend) {
              xhr.onloadend();
            }
          }, 0);
          return;
        }

        return originalSend.apply(this, arguments);
      };

      return xhr;
    }

    LocalFilePatchedXHR.prototype = OriginalXHR.prototype;
    LocalFilePatchedXHR.UNSENT = OriginalXHR.UNSENT;
    LocalFilePatchedXHR.OPENED = OriginalXHR.OPENED;
    LocalFilePatchedXHR.HEADERS_RECEIVED = OriginalXHR.HEADERS_RECEIVED;
    LocalFilePatchedXHR.LOADING = OriginalXHR.LOADING;
    LocalFilePatchedXHR.DONE = OriginalXHR.DONE;
    LocalFilePatchedXHR.__localFileStatusPatch = true;
    LocalFilePatchedXHR.__originalXHR = OriginalXHR;

    window.XMLHttpRequest = LocalFilePatchedXHR;
    earlyLocalFileXHRPatched = true;

    if (
      !earlyLocalFetchPatched &&
      typeof window.fetch === "function" &&
      !window.fetch.__localAssetJsonPatch
    ) {
      var originalFetch = window.fetch;
      window.fetch = function (input, init) {
        var requestUrl =
          typeof input === "string"
            ? input
            : input && input.url
              ? input.url
              : "";
        var embeddedJsonText = getEmbeddedLocalJsonText(requestUrl);
        if (embeddedJsonText !== null) {
          if (typeof Response !== "undefined") {
            return Promise.resolve(
              new Response(embeddedJsonText, {
                status: 200,
                statusText: "OK",
                headers: { "Content-Type": "application/json" },
              }),
            );
          }

          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: "OK",
            text: function () {
              return Promise.resolve(embeddedJsonText);
            },
            json: function () {
              return Promise.resolve(JSON.parse(embeddedJsonText));
            },
          });
        }

        return originalFetch.apply(this, arguments);
      };

      window.fetch.__localAssetJsonPatch = true;
      window.fetch.__originalFetch = originalFetch;
      earlyLocalFetchPatched = true;
    }
  }

  function cloneSongRecord(song, sourceOverride) {
    if (!song) {
      return null;
    }

    var cloned = {
      id: song.id,
      title: song.title,
      dirName: song.dirName,
      chartPath: song.chartPath,
      audioPath: song.audioPath,
      coverPath: song.coverPath,
      aliases: (song.aliases || []).slice(),
      source: sourceOverride || song.source,
      persistentKey: song.persistentKey || null,
    };

    if (song.chartData) {
      cloned.chartData = song.chartData;
    }

    return cloned;
  }

  function normalizeManifestSongEntry(entry, index) {
    if (!entry || !entry.chartPath || !entry.audioPath) {
      return null;
    }

    return {
      id: entry.id || entry.dirName || entry.title || "manifest-song-" + index,
      title: entry.title || entry.dirName || entry.id || "Song " + (index + 1),
      dirName: entry.dirName || entry.title || entry.id || "",
      chartPath: entry.chartPath,
      audioPath: entry.audioPath,
      coverPath: entry.coverPath || null,
      aliases: Array.isArray(entry.aliases) ? entry.aliases.slice() : [],
      source: entry.source || EMBEDDED_MANIFEST_SOURCE,
      chartData: entry.chartData || null,
      persistentKey:
        entry.persistentKey || entry.chartPath || entry.audioPath || entry.id || null,
    };
  }

  function getEmbeddedManifestSongs() {
    if (embeddedManifestSongsCache) {
      return embeddedManifestSongsCache;
    }

    var manifest = window.__LOCAL_SONG_MANIFEST__;
    var rawSongs = Array.isArray(manifest)
      ? manifest
      : manifest && Array.isArray(manifest.songs)
        ? manifest.songs
        : [];
    var songs = [];

    for (var i = 0; i < rawSongs.length; i++) {
      var normalizedSong = normalizeManifestSongEntry(rawSongs[i], i);
      if (normalizedSong) {
        songs.push(normalizedSong);
      }
    }

    embeddedManifestSongsCache = songs;
    return songs;
  }

  function logEmbeddedManifestUsage(reason) {
    var manifest = window.__LOCAL_SONG_MANIFEST__;
    var details = [
      "Using embedded song manifest",
      "reason=" + (reason || "unknown"),
      "songs=" + getEmbeddedManifestSongs().length,
    ];

    if (manifest && manifest.generatedAt) {
      details.push("generatedAt=" + manifest.generatedAt);
    }

    if (isLocalFileProtocol()) {
      details.push("mode=file-protocol");
    }

    console.warn(details.join(" | "));
  }

  function shouldPreferEmbeddedManifest() {
    var manifest = window.__LOCAL_SONG_MANIFEST__;
    return isAndroidAssetRuntime() || !!(manifest && manifest.preferManifest);
  }

  function findEmbeddedManifestSong(requestedKey) {
    var songs = getEmbeddedManifestSongs();
    if (!songs.length) {
      return null;
    }

    if (!requestedKey) {
      return cloneSongRecord(songs[0]);
    }

    var normalizedKey = normalizeKey(requestedKey);
    for (var i = 0; i < songs.length; i++) {
      var song = songs[i];
      if (
        normalizeKey(song.id) === normalizedKey ||
        normalizeKey(song.dirName) === normalizedKey ||
        normalizeKey(song.title) === normalizedKey
      ) {
        return cloneSongRecord(song);
      }

      for (var j = 0; j < song.aliases.length; j++) {
        if (normalizeKey(song.aliases[j]) === normalizedKey) {
          return cloneSongRecord(song);
        }
      }
    }

    return null;
  }

  function updateSongSelectorMetrics() {
    if (!songSelectorState.root || !window.getComputedStyle) {
      return;
    }

    var computedStyle = window.getComputedStyle(songSelectorState.root);
    var rawValue = parseFloat(
      computedStyle.getPropertyValue("--song-selector-row-height"),
    );
    if (isFinite(rawValue) && rawValue > 0) {
      songSelectorRowHeight = rawValue;
    } else {
      songSelectorRowHeight = DEFAULT_SONG_SELECTOR_ROW_HEIGHT;
    }
  }

  function ensurePlayerHudUI() {
    if (playerHudState.root) {
      return;
    }

    var root = document.createElement("div");
    root.id = "player-hud";
    root.className = "player-hud player-hud--hidden";
    root.innerHTML =
      "" +
      '<div class="player-hud__top">' +
      '  <button class="player-hud__back" type="button">\u8fd4\u56de\u9009\u6b4c</button>' +
      '  <div class="player-hud__progress">' +
      '    <div class="player-hud__meta">' +
      '      <div class="player-hud__title">\u51c6\u5907\u64ad\u653e</div>' +
      '      <div class="player-hud__time"><span class="player-hud__elapsed">0:00</span> / <span class="player-hud__duration">0:00</span></div>' +
      "    </div>" +
      '    <div class="player-hud__track"><div class="player-hud__fill"></div></div>' +
      "  </div>" +
      "</div>";

    document.body.appendChild(root);

    playerHudState.root = root;
    playerHudState.backButton = root.querySelector(".player-hud__back");
    playerHudState.title = root.querySelector(".player-hud__title");
    playerHudState.elapsed = root.querySelector(".player-hud__elapsed");
    playerHudState.duration = root.querySelector(".player-hud__duration");
    playerHudState.progressFill = root.querySelector(".player-hud__fill");

    playerHudState.backButton.addEventListener("click", function () {
      returnToSongSelector("manual-back");
    });
  }

  function cancelPlayerHudRender() {
    var caf = window.cancelAnimationFrame || clearTimeout;
    if (playerHudState.renderFrame) {
      caf(playerHudState.renderFrame);
      playerHudState.renderFrame = 0;
    }
  }

  function updatePlayerHudProgress(currentTime, duration) {
    if (!playerHudState.root) {
      return;
    }

    var safeCurrent = Math.max(0, currentTime || 0);
    var safeDuration = Math.max(0, duration || 0);
    var progress =
      safeDuration > 0 ? Math.min(100, (safeCurrent / safeDuration) * 100) : 0;

    playerHudState.elapsed.textContent = formatTimeLabel(safeCurrent);
    playerHudState.duration.textContent = formatTimeLabel(safeDuration);
    playerHudState.progressFill.style.width = progress.toFixed(2) + "%";
  }

  function setPlayerHudSong(song) {
    ensurePlayerHudUI();
    playerHudState.title.textContent =
      song && (song._displayTitle || song.title || song.dirName)
        ? song._displayTitle || song.title || song.dirName
        : "\u51c6\u5907\u64ad\u653e";
    playerHudState.completionTicks = 0;
    updatePlayerHudProgress(0, 0);
  }

  function setPlayerHudVisible(visible) {
    ensurePlayerHudUI();
    playerHudState.visible = !!visible;
    playerHudState.root.classList.toggle("player-hud--hidden", !visible);

    if (visible) {
      schedulePlayerHudRender();
    } else {
      cancelPlayerHudRender();
      playerHudState.completionTicks = 0;
    }
  }

  function detachPreviewAudioElement() {
    if (previewAudioElement && previewAudioEvents) {
      previewAudioElement.removeEventListener(
        "playing",
        previewAudioEvents.playing,
      );
      previewAudioElement.removeEventListener("pause", previewAudioEvents.pause);
      previewAudioElement.removeEventListener("ended", previewAudioEvents.ended);
      previewAudioElement.removeEventListener("error", previewAudioEvents.error);
    }

    previewAudioElement = null;
    previewAudioEvents = null;
  }

  function isSongPreviewActive(songKey) {
    return !!(
      songKey &&
      previewAudioElement &&
      (previewAudioLoadingKey === songKey || previewAudioSongKey === songKey)
    );
  }

  function stopSongPreview() {
    if (previewAudioElement) {
      try {
        previewAudioElement.pause();
        previewAudioElement.currentTime = 0;
        previewAudioElement.removeAttribute("src");
        previewAudioElement.load();
      } catch (err) {
        console.warn("Failed to stop song preview audio:", err);
      }
    }

    detachPreviewAudioElement();
    previewAudioSongKey = "";
    previewAudioLoadingKey = "";
  }

  function startSongPreview(song) {
    if (!song || !song.audioPath) {
      stopSongPreview();
      return;
    }

    var songKey = song._selectorKey || getSongUniqueKey(song);
    if (isSongPreviewActive(songKey)) {
      return;
    }

    stopSongPreview();

    var audio = new Audio();
    previewAudioElement = audio;
    previewAudioSongKey = "";
    previewAudioLoadingKey = songKey;
    audio.preload = "auto";
    audio.src = song.audioPath;
    audio.volume = 1;

    previewAudioEvents = {
      playing: function () {
        previewAudioSongKey = songKey;
        previewAudioLoadingKey = "";
      },
      pause: function () {
        if (!audio.ended && previewAudioSongKey === songKey) {
          previewAudioSongKey = "";
        }
      },
      ended: function () {
        previewAudioSongKey = "";
        previewAudioLoadingKey = "";
      },
      error: function () {
        console.warn("Song preview audio failed:", song.audioPath);
        previewAudioSongKey = "";
        previewAudioLoadingKey = "";
      },
    };

    audio.addEventListener("playing", previewAudioEvents.playing);
    audio.addEventListener("pause", previewAudioEvents.pause);
    audio.addEventListener("ended", previewAudioEvents.ended);
    audio.addEventListener("error", previewAudioEvents.error);

    try {
      var playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(function (err) {
          if (previewAudioElement === audio) {
            detachPreviewAudioElement();
            previewAudioSongKey = "";
            previewAudioLoadingKey = "";
          }
          console.warn("Song preview playback was blocked:", err);
        });
      }
    } catch (err) {
      detachPreviewAudioElement();
      previewAudioSongKey = "";
      previewAudioLoadingKey = "";
      console.warn("Song preview playback threw synchronously:", err);
    }
  }

  function detachCurrentAudioElement() {
    if (currentAudioElement && currentAudioEvents) {
      currentAudioElement.removeEventListener(
        "loadedmetadata",
        currentAudioEvents.loadedmetadata,
      );
      currentAudioElement.removeEventListener(
        "durationchange",
        currentAudioEvents.durationchange,
      );
      currentAudioElement.removeEventListener(
        "ended",
        currentAudioEvents.ended,
      );
      currentAudioElement.removeEventListener("play", currentAudioEvents.play);
      currentAudioElement.removeEventListener(
        "pause",
        currentAudioEvents.pause,
      );
    }

    currentAudioElement = null;
    currentAudioEvents = null;
  }

  function handlePlaybackCompleted() {
    if (returningToSongSelector || playbackCompletionQueued) {
      return;
    }

    playbackCompletionQueued = true;
    console.log("Playback completed, returning to song selector");
    updatePlayerHudProgress(
      resolvePlaybackCurrentTime(),
      resolvePlaybackDuration(),
    );
    window.setTimeout(function () {
      returnToSongSelector("playback-complete");
    }, 420);
  }

  function bindCurrentAudioElement(audio) {
    if (!audio) {
      return;
    }

    detachCurrentAudioElement();
    currentAudioElement = audio;
    currentAudioEvents = {
      loadedmetadata: function () {
        updatePlayerHudProgress(
          resolvePlaybackCurrentTime(),
          resolvePlaybackDuration(),
        );
      },
      durationchange: function () {
        updatePlayerHudProgress(
          resolvePlaybackCurrentTime(),
          resolvePlaybackDuration(),
        );
      },
      ended: function () {
        handlePlaybackCompleted();
      },
      play: function () {
        schedulePlayerHudRender();
      },
      pause: function () {
        updatePlayerHudProgress(
          resolvePlaybackCurrentTime(),
          resolvePlaybackDuration(),
        );
      },
    };

    audio.addEventListener("loadedmetadata", currentAudioEvents.loadedmetadata);
    audio.addEventListener("durationchange", currentAudioEvents.durationchange);
    audio.addEventListener("ended", currentAudioEvents.ended);
    audio.addEventListener("play", currentAudioEvents.play);
    audio.addEventListener("pause", currentAudioEvents.pause);
  }

  function findPlaybackComponent() {
    if (
      cachedPlaybackComponent &&
      cachedPlaybackComponent.node &&
      (!window.cc ||
        !cc.isValid ||
        cc.isValid(cachedPlaybackComponent.node, true))
    ) {
      return cachedPlaybackComponent;
    }

    if (typeof cc === "undefined" || !cc.director || !cc.director.getScene) {
      return null;
    }

    var scene = cc.director.getScene();
    if (!scene) {
      return null;
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
        if (
          component &&
          component._audioSource &&
          typeof component.onArrowRender === "function" &&
          typeof component.refreshRenderData === "function"
        ) {
          cachedPlaybackComponent = component;
          return component;
        }
      }

      var children = node.children || [];
      for (var j = 0; j < children.length; j++) {
        queue.push(children[j]);
      }
    }

    return null;
  }

  function resolvePlaybackAudioSource() {
    var playbackComponent = findPlaybackComponent();
    return playbackComponent && playbackComponent._audioSource
      ? playbackComponent._audioSource
      : null;
  }

  function resolvePlaybackDuration() {
    if (
      currentAudioElement &&
      isFinite(currentAudioElement.duration) &&
      currentAudioElement.duration > 0
    ) {
      return currentAudioElement.duration;
    }

    var audioSource = resolvePlaybackAudioSource();
    if (!audioSource || !audioSource.clip) {
      return 0;
    }

    if (typeof audioSource.clip.getDuration === "function") {
      try {
        var clipDuration = audioSource.clip.getDuration();
        if (isFinite(clipDuration) && clipDuration > 0) {
          return clipDuration;
        }
      } catch (err) {
        // Ignore duration lookup failures from older Cocos builds.
      }
    }

    var nativeAsset = audioSource.clip._nativeAsset;
    if (
      nativeAsset &&
      isFinite(nativeAsset.duration) &&
      nativeAsset.duration > 0
    ) {
      return nativeAsset.duration;
    }

    return 0;
  }

  function resolvePlaybackCurrentTime() {
    var audioSource = resolvePlaybackAudioSource();
    var audioElementTime =
      currentAudioElement &&
      isFinite(currentAudioElement.currentTime) &&
      currentAudioElement.currentTime >= 0
        ? currentAudioElement.currentTime
        : NaN;

    if (audioSource && typeof audioSource.getCurrentTime === "function") {
      try {
        var currentTime = audioSource.getCurrentTime();
        if (isFinite(currentTime) && currentTime >= 0) {
          if (
            !isFinite(audioElementTime) ||
            currentTime > audioElementTime + 0.05
          ) {
            return currentTime;
          }
        }
      } catch (err) {
        // Ignore currentTime lookup failures from older Cocos builds.
      }
    }

    if (isFinite(audioElementTime)) {
      return audioElementTime;
    }

    return 0;
  }

  function schedulePlayerHudRender() {
    if (!playerHudState.visible || playerHudState.renderFrame) {
      return;
    }

    var raf =
      window.requestAnimationFrame ||
      function (callback) {
        return setTimeout(callback, 16);
      };

    playerHudState.renderFrame = raf(function () {
      playerHudState.renderFrame = 0;

      if (!playerHudState.visible) {
        return;
      }

      var currentTime = resolvePlaybackCurrentTime();
      var duration = resolvePlaybackDuration();
      updatePlayerHudProgress(currentTime, duration);

      if (duration > 1 && currentTime >= duration - 0.18) {
        playerHudState.completionTicks++;
        if (playerHudState.completionTicks >= 8) {
          handlePlaybackCompleted();
          return;
        }
      } else {
        playerHudState.completionTicks = 0;
      }

      schedulePlayerHudRender();
    });
  }

  function returnToSongSelector(reason) {
    if (returningToSongSelector) {
      return;
    }

    returningToSongSelector = true;
    console.log("Returning to song selector:", reason || "manual");
    stopSongPreview();
    setPlayerHudVisible(false);

    var audioSource = resolvePlaybackAudioSource();
    if (audioSource && typeof audioSource.stop === "function") {
      try {
        audioSource.stop();
      } catch (err) {
        console.warn(
          "Failed to stop playback audio source before returning:",
          err,
        );
      }
    }

    if (currentAudioElement) {
      try {
        currentAudioElement.pause();
        currentAudioElement.currentTime = 0;
      } catch (err) {
        console.warn(
          "Failed to reset active audio element before returning:",
          err,
        );
      }
    }

    detachCurrentAudioElement();
    playbackCompletionQueued = false;

    window.setTimeout(function () {
      window.location.replace(getBasePageUrl());
    }, 80);
  }

  function getUrlParam(name) {
    var url = window.location.href;
    var regex = new RegExp("[?&]" + name + "=([^&#]*)");
    var match = regex.exec(url);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function normalizeKey(value) {
    return (value || "").replace(/^\s+|\s+$/g, "").toLowerCase();
  }

  function stripTrailingSlash(value) {
    return value ? value.replace(/\/$/, "") : value;
  }

  function stripExtension(value) {
    return value ? value.replace(/\.[^.]+$/, "") : value;
  }

  function uniquePaths(paths) {
    var result = [];
    var seen = {};

    for (var i = 0; i < paths.length; i++) {
      var item = paths[i];
      if (!item || seen[item]) {
        continue;
      }
      seen[item] = true;
      result.push(item);
    }

    return result;
  }

  function buildDefaultSong() {
    return {
      id: "default",
      title: "default",
      dirName: "",
      chartPath: ROOT_CHART_FALLBACKS[0],
      audioPath: ROOT_AUDIO_FALLBACKS[0],
      coverPath: null,
      aliases: ["default"],
      source: "root-default",
    };
  }

  function encodeSongDirectory(name) {
    return (
      SONGS_ROOT + encodeURIComponent(name || "").replace(/%2F/g, "/") + "/"
    );
  }

  function isJsonFile(name) {
    return /\.json$/i.test(name || "");
  }

  function isAudioFile(name) {
    return /\.(mp3|ogg|wav)$/i.test(name || "");
  }

  function isImageFile(name) {
    return /\.(jpg|jpeg|png|webp)$/i.test(name || "");
  }

  function listDirectory(path) {
    return loadTextFromPath(path).then(function (html) {
      var parser = new DOMParser();
      var doc = parser.parseFromString(html, "text/html");
      var links = doc.querySelectorAll("a");
      var entries = [];
      var seen = {};

      for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute("href");
        if (!href || href === "../") {
          continue;
        }

        var cleanHref = href.split("?")[0];
        if (!cleanHref || cleanHref === "../") {
          continue;
        }

        var name = stripTrailingSlash(decodeURIComponent(cleanHref));
        if (!name || name === "." || name === ".." || name.charAt(0) === ".") {
          continue;
        }

        if (seen[cleanHref]) {
          continue;
        }

        seen[cleanHref] = true;
        entries.push({
          name: name,
          href: cleanHref,
          isDirectory: /\/$/.test(cleanHref),
        });
      }

      return entries;
    });
  }

  function buildPreferredBases(displayName, chartName, audioName) {
    var bases = [];
    var seen = {};
    var values = [displayName, chartName, audioName];

    for (var i = 0; i < values.length; i++) {
      var base = normalizeKey(stripExtension(values[i]));
      if (base && !seen[base]) {
        seen[base] = true;
        bases.push(base);
      }
    }

    var parts = (displayName || "").split("#");
    for (var j = 0; j < parts.length; j++) {
      var partBase = normalizeKey(stripExtension(parts[j]));
      if (partBase && !seen[partBase]) {
        seen[partBase] = true;
        bases.push(partBase);
      }
    }

    return bases;
  }

  function findFileByBase(files, bases) {
    for (var i = 0; i < bases.length; i++) {
      for (var j = 0; j < files.length; j++) {
        if (normalizeKey(stripExtension(files[j].name)) === bases[i]) {
          return files[j];
        }
      }
    }

    return null;
  }

  function chooseBestMediaPair(displayName, chartFiles, audioFiles) {
    for (var i = 0; i < chartFiles.length; i++) {
      var chartBase = normalizeKey(stripExtension(chartFiles[i].name));
      for (var j = 0; j < audioFiles.length; j++) {
        var audioBase = normalizeKey(stripExtension(audioFiles[j].name));
        if (chartBase && chartBase === audioBase) {
          return {
            chart: chartFiles[i],
            audio: audioFiles[j],
          };
        }
      }
    }

    var preferredBases = buildPreferredBases(displayName, "", "");
    var preferredChart = findFileByBase(chartFiles, preferredBases);
    var preferredAudio = findFileByBase(audioFiles, preferredBases);

    if (preferredChart && preferredAudio) {
      return {
        chart: preferredChart,
        audio: preferredAudio,
      };
    }

    if (preferredChart && audioFiles.length === 1) {
      return {
        chart: preferredChart,
        audio: audioFiles[0],
      };
    }

    if (preferredAudio && chartFiles.length === 1) {
      return {
        chart: chartFiles[0],
        audio: preferredAudio,
      };
    }

    if (chartFiles.length > 0 && audioFiles.length > 0) {
      return {
        chart: chartFiles[0],
        audio: audioFiles[0],
      };
    }

    return null;
  }

  function chooseBestCover(displayName, imageFiles, pair) {
    if (!imageFiles.length) {
      return null;
    }

    var preferredBases = buildPreferredBases(
      displayName,
      pair && pair.chart ? pair.chart.name : "",
      pair && pair.audio ? pair.audio.name : "",
    );

    for (var i = 0; i < imageFiles.length; i++) {
      if (/(bann|banner|cover|bg)/i.test(imageFiles[i].name)) {
        return imageFiles[i];
      }
    }

    var preferredCover = findFileByBase(imageFiles, preferredBases);
    return preferredCover || imageFiles[0];
  }

  function buildSongAliases(displayName, pair) {
    var aliases = [];
    var seen = {};
    var rawValues = [displayName];

    if (pair && pair.chart) {
      rawValues.push(stripExtension(pair.chart.name));
    }
    if (pair && pair.audio) {
      rawValues.push(stripExtension(pair.audio.name));
    }

    var parts = (displayName || "").split("#");
    for (var i = 0; i < parts.length; i++) {
      rawValues.push(parts[i]);
    }

    for (var j = 0; j < rawValues.length; j++) {
      var normalized = normalizeKey(rawValues[j]);
      if (!normalized || seen[normalized]) {
        continue;
      }
      seen[normalized] = true;
      aliases.push(rawValues[j]);
    }

    return aliases;
  }

  function buildSongFromFiles(basePath, displayName, files, source) {
    var chartFiles = [];
    var audioFiles = [];
    var imageFiles = [];

    for (var i = 0; i < files.length; i++) {
      var entry = files[i];
      if (entry.isDirectory) {
        continue;
      }
      if (isJsonFile(entry.name)) {
        chartFiles.push(entry);
      } else if (isAudioFile(entry.name)) {
        audioFiles.push(entry);
      } else if (isImageFile(entry.name)) {
        imageFiles.push(entry);
      }
    }

    var pair = chooseBestMediaPair(displayName, chartFiles, audioFiles);
    if (!pair) {
      return null;
    }

    var cover = chooseBestCover(displayName, imageFiles, pair);
    return {
      id: displayName,
      title: stripExtension(pair.audio.name || pair.chart.name || displayName),
      dirName: displayName,
      chartPath: basePath + pair.chart.href,
      audioPath: basePath + pair.audio.href,
      coverPath: cover ? basePath + cover.href : null,
      aliases: buildSongAliases(displayName, pair),
      source: source,
      persistentKey: basePath + pair.chart.href,
    };
  }

  function discoverSongsFromEmbeddedManifest(options) {
    options = options || {};

    var manifestSongs = getEmbeddedManifestSongs();
    if (!manifestSongs.length) {
      if (options.onStatus) {
        options.onStatus({
          totalDirectories: 0,
          scannedDirectories: 0,
          songCount: 0,
          scanComplete: true,
        });
      }
      return Promise.resolve([]);
    }

    logEmbeddedManifestUsage(options.reason);
    songLibrarySourceMode = EMBEDDED_MANIFEST_SOURCE;
    songLibrarySourceLabel = "";

    var songs = [];
    for (var i = 0; i < manifestSongs.length; i++) {
      songs.push(cloneSongRecord(manifestSongs[i], EMBEDDED_MANIFEST_SOURCE));
      if (options.onSong) {
        options.onSong(songs[songs.length - 1]);
      }
      if (options.onStatus) {
        options.onStatus({
          totalDirectories: manifestSongs.length,
          scannedDirectories: i + 1,
          songCount: songs.length,
          scanComplete: i + 1 >= manifestSongs.length,
        });
      }
    }

    console.log("Using embedded song manifest with", songs.length, "songs");
    return Promise.resolve(songs);
  }

  function analyzeSongDirectory(basePath, displayName, source) {
    var manifestSong = shouldPreferEmbeddedManifest()
      ? findEmbeddedManifestSong(displayName)
      : null;
    if (manifestSong) {
      manifestSong.source = source || manifestSong.source;
      return Promise.resolve(manifestSong);
    }

    return listDirectory(basePath)
      .then(function (entries) {
        var song = buildSongFromFiles(basePath, displayName, entries, source);
        if (!song) {
          console.warn("No playable chart/audio pair found in:", basePath);
        }
        return song;
      })
      .catch(function (err) {
        console.warn("Failed to analyze song directory:", basePath, err);
        return null;
      });
  }

  function runWithConcurrency(items, limit, iterator, onSettled) {
    limit = Math.max(1, limit || 1);

    return new Promise(function (resolve) {
      var results = new Array(items.length);
      var nextIndex = 0;
      var activeCount = 0;

      function launchNext() {
        if (nextIndex >= items.length && activeCount === 0) {
          resolve(results);
          return;
        }

        while (activeCount < limit && nextIndex < items.length) {
          (function (index) {
            activeCount++;

            Promise.resolve(iterator(items[index], index))
              .then(
                function (result) {
                  results[index] = result;
                  if (onSettled) {
                    onSettled(null, result, index);
                  }
                },
                function (err) {
                  results[index] = null;
                  if (onSettled) {
                    onSettled(err, null, index);
                  }
                },
              )
              .then(function () {
                activeCount--;
                launchNext();
              });
          })(nextIndex);

          nextIndex++;
        }
      }

      launchNext();
    });
  }

  function discoverSongsFromSongsDir(options) {
    options = options || {};

    function scanBundledSongsDirectory() {
      songLibrarySourceMode = "songs-directory";
      songLibrarySourceLabel = "songs";
      return listDirectory(SONGS_ROOT)
        .then(function (entries) {
          var songs = [];
          var directories = [];
          var rootFiles = [];
          var scannedCount = 0;

          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isDirectory) {
              directories.push(entries[i]);
            } else {
              rootFiles.push(entries[i]);
            }
          }

          var rootSong = buildSongFromFiles(
            SONGS_ROOT,
            "songs",
            rootFiles,
            "songs-root",
          );
          if (rootSong) {
            songs.push(rootSong);
            if (options.onSong) {
              options.onSong(rootSong);
            }
          }

          if (options.onStatus) {
            options.onStatus({
              totalDirectories: directories.length,
              scannedDirectories: scannedCount,
              songCount: songs.length,
              scanComplete: directories.length === 0,
            });
          }

          if (!directories.length) {
            return songs;
          }

          return runWithConcurrency(
            directories,
            options.concurrency || MAX_DISCOVERY_CONCURRENCY,
            function (entry) {
              return analyzeSongDirectory(
                SONGS_ROOT + entry.href,
                entry.name,
                "songs-directory",
              );
            },
            function (err, song) {
              scannedCount++;

              if (err) {
                console.warn("Failed to analyze song directory:", err);
              }

              if (song) {
                songs.push(song);
                if (options.onSong) {
                  options.onSong(song);
                }
              }

              if (options.onStatus) {
                options.onStatus({
                  totalDirectories: directories.length,
                  scannedDirectories: scannedCount,
                  songCount: songs.length,
                  scanComplete: scannedCount >= directories.length,
                });
              }
            },
          ).then(function () {
            return songs;
          });
        });
    }

    function fallbackToManifest(reason) {
      if (getEmbeddedManifestSongs().length) {
        console.log("Falling back to embedded song manifest");
        options.reason = reason || "scan-failed";
        return discoverSongsFromEmbeddedManifest(options);
      }
      if (options.onStatus) {
        options.onStatus({
          totalDirectories: 0,
          scannedDirectories: 0,
          songCount: 0,
          scanComplete: true,
        });
      }
      return Promise.resolve([]);
    }

    function scanBundledOrManifest() {
      if (shouldPreferEmbeddedManifest() && getEmbeddedManifestSongs().length) {
        options.reason = isLocalFileProtocol() ? "file-protocol" : "prefer-manifest";
        return discoverSongsFromEmbeddedManifest(options);
      }

      return scanBundledSongsDirectory().catch(function (err) {
        console.warn("Failed to scan songs directory:", err);
        return fallbackToManifest("scan-failed");
      });
    }

    return restorePickedSongsDirectoryHandle()
      .then(function (restoredHandle) {
        var handle = pickedSongsDirectoryHandle || restoredHandle;
        if (!handle) {
          return scanBundledOrManifest();
        }

        return ensureSongsDirectoryReadable(handle, false).then(function (readable) {
          if (!readable) {
            setPickedSongsDirectoryHandle(null);
            return clearSavedSongsDirectoryHandle().then(function () {
              return scanBundledOrManifest();
            });
          }

          setPickedSongsDirectoryHandle(handle);
          return discoverSongsFromPickedDirectory(options).catch(function (err) {
            console.warn("Picked songs directory scan failed, fallback to bundled sources:", err);
            songLibraryStatusMessage = "外部 songs 目录读取失败，已回退内置曲库";
            return scanBundledOrManifest();
          });
        });
      })
      .catch(function (err) {
        console.warn("Failed to prepare songs directory discovery:", err);
        return scanBundledOrManifest();
      });
  }

  function songMatchesKey(song, requestedKey) {
    if (!song || !requestedKey) {
      return false;
    }

    var wanted = normalizeKey(requestedKey);
    if (
      normalizeKey(song.dirName) === wanted ||
      normalizeKey(song.title) === wanted
    ) {
      return true;
    }

    var aliases = song.aliases || [];
    for (var i = 0; i < aliases.length; i++) {
      if (normalizeKey(aliases[i]) === wanted) {
        return true;
      }
    }

    return false;
  }

  function chooseRequestedSong(songs, requestedKey) {
    if (!requestedKey) {
      return songs.length ? songs[0] : null;
    }

    for (var i = 0; i < songs.length; i++) {
      if (songMatchesKey(songs[i], requestedKey)) {
        return songs[i];
      }
    }

    return null;
  }

  function applySongSelection(song) {
    currentSong = song || buildDefaultSong();
    currentSongPath = currentSong.chartPath;
    currentMusicPath = currentSong.audioPath;
    playbackCompletionQueued = false;
    setPlayerHudSong(currentSong);

    console.log(
      "Selected song:",
      currentSong.dirName || currentSong.title || "default",
    );
    console.log("Chart path:", currentSongPath);
    console.log("Audio path:", currentMusicPath);
  }

  function readStoredSongKey() {
    try {
      return window.localStorage
        ? window.localStorage.getItem(SONG_SELECTOR_STORAGE_KEY) || ""
        : "";
    } catch (err) {
      return "";
    }
  }

  function storeSelectedSongKey(song) {
    try {
      if (window.localStorage && song) {
        window.localStorage.setItem(
          SONG_SELECTOR_STORAGE_KEY,
          song.dirName || song.title || song.id || "",
        );
      }
    } catch (err) {
      // Ignore storage errors.
    }
  }

  function getSongUniqueKey(song) {
    return normalizeKey(
      [
        song && song.persistentKey ? song.persistentKey : "",
        song && song.dirName ? song.dirName : "",
        song && song.chartPath ? song.chartPath : "",
        song && song.audioPath ? song.audioPath : "",
      ].join("|"),
    );
  }

  function buildSongBadges(song) {
    var badges = [];
    var seen = {};
    var parts = (song && song.dirName ? song.dirName : "").split("#");

    for (var i = 0; i < parts.length; i++) {
      var token = (parts[i] || "").replace(/^\s+|\s+$/g, "");
      if (!token) {
        continue;
      }

      if (/^\d+$/.test(token)) {
        token = "Lv." + token;
      }

      var normalized = normalizeKey(token);
      if (normalized && !seen[normalized]) {
        seen[normalized] = true;
        badges.push(token);
      }
    }

    if (!badges.length) {
      if (song && song.source === "songs-root") {
        badges.push("ROOT");
      } else if (song && song.source === "root-default") {
        badges.push("DEFAULT");
      } else if (song && song.source === "picked-directory") {
        badges.push("DIR");
      } else if (song && song.source === EMBEDDED_MANIFEST_SOURCE) {
        badges.push("PACK");
      } else {
        badges.push("LOCAL");
      }
    }

    return badges.slice(0, 3);
  }

  function buildSongCoverText(title) {
    var clean = (title || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    if (!clean) {
      return "SW";
    }

    if (/[\u4e00-\u9fff]/.test(clean)) {
      return clean.slice(0, 2);
    }

    var parts = clean.split(" ");
    var letters = "";

    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) {
        letters += parts[i].charAt(0).toUpperCase();
      }
      if (letters.length >= 2) {
        break;
      }
    }

    if (!letters) {
      letters = clean.slice(0, 2).toUpperCase();
    }

    return letters.slice(0, 2);
  }

  function prepareSongForSelector(song) {
    if (!song) {
      return null;
    }

    if (song._selectorPrepared) {
      return song;
    }

    var title = song.title || song.dirName || "Unknown";
    var subtitle = "本地曲库";

    if (song.dirName && song.dirName !== title) {
      subtitle = song.dirName;
    } else if (song.source === "songs-root") {
      subtitle = "songs 根目录";
    } else if (song.source === "root-default") {
      subtitle = "默认回退资源";
    }

    song._selectorPrepared = true;
    song._selectorKey = getSongUniqueKey(song);
    song._displayTitle = title;
    song._displaySubtitle = subtitle;
    song._badges = buildSongBadges(song);
    song._coverText = buildSongCoverText(title);
    song._searchText = normalizeKey(
      [
        title,
        subtitle,
        (song.aliases || []).join(" "),
        song._badges.join(" "),
      ].join(" "),
    );

    return song;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char];
    });
  }

  function findSongByUniqueKey(list, key) {
    if (!list || !key) {
      return null;
    }

    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i]._selectorKey === key) {
        return list[i];
      }
    }

    return null;
  }

  function buildTagHtml(tags) {
    var html = [];

    for (var i = 0; i < tags.length; i++) {
      html.push(
        '<span class="song-selector__tag">' + escapeHtml(tags[i]) + "</span>",
      );
    }

    return html.join("");
  }

  function findSongSelectorItem(node) {
    while (node && node !== songSelectorState.listViewport) {
      if (node.classList && node.classList.contains("song-selector__item")) {
        return node;
      }
      node = node.parentNode;
    }

    return null;
  }

  function resetSongTapState() {
    songSelectorState.pointerId = null;
    songSelectorState.pointerSongKey = "";
    songSelectorState.pointerStartX = 0;
    songSelectorState.pointerStartY = 0;
    songSelectorState.pointerStartScrollTop = 0;
    songSelectorState.pointerMoved = false;
  }

  function selectSongFromNode(node, ensureVisible) {
    var item = findSongSelectorItem(node);
    if (!item) {
      return false;
    }

    var songKey = item.getAttribute("data-song-key");
    if (!songKey) {
      return false;
    }

    setSelectedSongByKey(songKey, !!ensureVisible);
    return true;
  }

  function beginSongTap(event) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      resetSongTapState();
      return;
    }

    var item = findSongSelectorItem(event.target);
    if (!item) {
      resetSongTapState();
      return;
    }

    songSelectorState.pointerId =
      event.pointerId === undefined ? "mouse" : event.pointerId;
    songSelectorState.pointerSongKey = item.getAttribute("data-song-key") || "";
    songSelectorState.pointerStartX = event.clientX || 0;
    songSelectorState.pointerStartY = event.clientY || 0;
    songSelectorState.pointerStartScrollTop = songSelectorState.listViewport
      ? songSelectorState.listViewport.scrollTop || 0
      : 0;
    songSelectorState.pointerMoved = false;
  }

  function updateSongTap(event) {
    if (
      !songSelectorState.pointerSongKey ||
      (songSelectorState.pointerId !== null &&
        event.pointerId !== undefined &&
        event.pointerId !== songSelectorState.pointerId)
    ) {
      return;
    }

    var deltaX = Math.abs((event.clientX || 0) - songSelectorState.pointerStartX);
    var deltaY = Math.abs((event.clientY || 0) - songSelectorState.pointerStartY);
    var deltaScroll = songSelectorState.listViewport
      ? Math.abs(
          (songSelectorState.listViewport.scrollTop || 0) -
            songSelectorState.pointerStartScrollTop,
        )
      : 0;

    if (deltaX > 12 || deltaY > 12 || deltaScroll > 12) {
      songSelectorState.pointerMoved = true;
    }
  }

  function commitSongTap(event) {
    if (
      songSelectorState.pointerId !== null &&
      event.pointerId !== undefined &&
      event.pointerId !== songSelectorState.pointerId
    ) {
      return;
    }

    var tappedSongKey = songSelectorState.pointerSongKey;
    var pointerMoved = songSelectorState.pointerMoved;
    resetSongTapState();

    if (!tappedSongKey || pointerMoved) {
      return;
    }

    setSelectedSongByKey(tappedSongKey, false);
  }

  function ensureSongSelectorUI() {
    if (songSelectorState.root) {
      return;
    }

    ensurePlayerHudUI();

    var root = document.createElement("div");
    root.id = "song-selector";
    root.className = "song-selector";
    root.innerHTML =
      "" +
      '<div class="song-selector__backdrop"></div>' +
      '<div class="song-selector__shell">' +
      '  <section class="song-selector__panel song-selector__panel--library">' +
      '    <div class="song-selector__header">' +
      '      <div class="song-selector__headerMain">' +
      '        <div class="song-selector__eyebrow">SingWorld Player</div>' +
      '        <h1 class="song-selector__heading">选择歌曲</h1>' +
      "      </div>" +
      '      <div class="song-selector__countBlock">' +
      '        <strong class="song-selector__countValue">0</strong>' +
      '        <span class="song-selector__countLabel">首</span>' +
      "      </div>" +
      "    </div>" +
      '    <div class="song-selector__listViewport">' +
      '      <div class="song-selector__listSpacer"></div>' +
      '      <div class="song-selector__listItems"></div>' +
      '      <div class="song-selector__empty" hidden>暂无可播放歌曲</div>' +
      "    </div>" +
      '    <div class="song-selector__status" aria-live="polite"></div>' +
      "  </section>" +
      '  <section class="song-selector__panel song-selector__panel--preview">' +
      '    <div class="song-selector__previewCard">' +
      '      <div class="song-selector__previewBg"></div>' +
      '      <div class="song-selector__previewCoverFrame">' +
      '        <img class="song-selector__previewCover" alt="">' +
      '        <div class="song-selector__previewFallback">SW</div>' +
      "      </div>" +
      '      <div class="song-selector__previewContent">' +
      '        <div class="song-selector__previewEyebrow">已选歌曲</div>' +
      '        <h2 class="song-selector__previewTitle">正在扫描曲库...</h2>' +
      '        <div class="song-selector__previewTags"></div>' +
      "      </div>" +
      "    </div>" +
      '    <div class="song-selector__actions">' +
      '      <div class="song-selector__toolbar">' +
      '        <button class="song-selector__button song-selector__button--secondary song-selector__button--pick" type="button">选择 songs 目录</button>' +
      '        <button class="song-selector__button song-selector__button--ghost song-selector__button--refresh" type="button">刷新曲库</button>' +
      '      </div>' +
      '      <button class="song-selector__button song-selector__button--primary" type="button" disabled>开始播放</button>' +
      "    </div>" +
      "  </section>" +
      "</div>";

    document.body.appendChild(root);
    if (document.body.classList) {
      document.body.classList.add("song-selector-active");
    }
    setPlayerHudVisible(false);

    songSelectorState.root = root;
    songSelectorState.countValue = root.querySelector(
      ".song-selector__countValue",
    );
    songSelectorState.countLabel = root.querySelector(
      ".song-selector__countLabel",
    );
    songSelectorState.status = root.querySelector(
      ".song-selector__status",
    );
    songSelectorState.scanMeta = null;
    songSelectorState.listViewport = root.querySelector(
      ".song-selector__listViewport",
    );
    songSelectorState.listSpacer = root.querySelector(
      ".song-selector__listSpacer",
    );
    songSelectorState.listItems = root.querySelector(
      ".song-selector__listItems",
    );
    songSelectorState.empty = root.querySelector(".song-selector__empty");
    songSelectorState.previewCard = root.querySelector(
      ".song-selector__previewCard",
    );
    songSelectorState.previewBg = root.querySelector(
      ".song-selector__previewBg",
    );
    songSelectorState.previewCover = root.querySelector(
      ".song-selector__previewCover",
    );
    songSelectorState.previewFallback = root.querySelector(
      ".song-selector__previewFallback",
    );
    songSelectorState.previewTitle = root.querySelector(
      ".song-selector__previewTitle",
    );
    songSelectorState.previewTags = root.querySelector(
      ".song-selector__previewTags",
    );
    songSelectorState.startButton = root.querySelector(
      ".song-selector__button--primary",
    );
    songSelectorState.chooseDirButton = root.querySelector(
      ".song-selector__button--pick",
    );
    songSelectorState.refreshButton = root.querySelector(
      ".song-selector__button--refresh",
    );
    updateSongSelectorMetrics();

    songSelectorState.previewCover.addEventListener("error", function () {
      songSelectorState.previewCover.style.display = "none";
    });

    songSelectorState.previewCard.addEventListener("click", function () {
      var selectedSong = findSongByUniqueKey(
        songSelectorState.orderedSongs,
        songSelectorState.selectedSongKey,
      );
      if (selectedSong) {
        stopSongPreview();
        startSongPreview(selectedSong);
      }
    });

    songSelectorState.listViewport.addEventListener("scroll", function () {
      updateSongTap({
        pointerId: songSelectorState.pointerId,
        clientX: songSelectorState.pointerStartX,
        clientY: songSelectorState.pointerStartY,
      });
    });

    if (window.PointerEvent) {
      songSelectorState.listViewport.addEventListener("pointerdown", beginSongTap, {
        passive: true,
      });
      songSelectorState.listViewport.addEventListener("pointermove", updateSongTap, {
        passive: true,
      });
      songSelectorState.listViewport.addEventListener("pointerup", commitSongTap, {
        passive: true,
      });
      songSelectorState.listViewport.addEventListener(
        "pointercancel",
        resetSongTapState,
        { passive: true },
      );
      songSelectorState.listViewport.addEventListener(
        "pointerleave",
        function (event) {
          if (event.pointerType === "mouse") {
            resetSongTapState();
          }
        },
        { passive: true },
      );
    }

    songSelectorState.listViewport.addEventListener("click", function (event) {
      selectSongFromNode(event.target, false);
    });

    songSelectorState.startButton.addEventListener("click", function () {
      startSelectedSong();
    });

    if (songSelectorState.chooseDirButton) {
      songSelectorState.chooseDirButton.addEventListener("click", function () {
        startSongsDirectoryPickerFlow();
      });
    }

    if (songSelectorState.refreshButton) {
      songSelectorState.refreshButton.addEventListener("click", function () {
        if (songSelectorState.scanInProgress) {
          return;
        }
        songLibraryStatusMessage = "";
        rerunSongSelectionFlow({ keepCurrentSelection: true });
      });
    }

    refreshSongSelectorButtons();
    updateSongSelectorStatus();

    window.addEventListener("resize", function () {
      updateSongSelectorMetrics();
      scheduleSongListRender();
      clampSongListScroll();
      schedulePlayerHudRender();
    });
  }

  function getDisplayedSongCount() {
    var scanMeta = songSelectorState.scanMeta;
    if (scanMeta && isFinite(scanMeta.songCount)) {
      return Math.max(0, scanMeta.songCount);
    }

    return songSelectorState.orderedSongs.length;
  }

  function updateSongSelectorCounts() {
    if (!songSelectorState.countValue) {
      return;
    }

    songSelectorState.countValue.textContent = String(getDisplayedSongCount());
    songSelectorState.countLabel.textContent = "首";
  }

  function updateSongSelectorStatus() {
    refreshSongSelectorButtons();
    if (!songSelectorState.status) {
      return;
    }
    songSelectorState.status.textContent = buildSongSelectorStatusText();
  }

  function updateSongPreview() {
    if (!songSelectorState.previewTitle) {
      return;
    }

    var selectedSong = findSongByUniqueKey(
      songSelectorState.orderedSongs,
      songSelectorState.selectedSongKey,
    );
    if (!selectedSong && songSelectorState.filteredSongs.length) {
      selectedSong = songSelectorState.filteredSongs[0];
      songSelectorState.selectedSongKey = selectedSong._selectorKey;
    }

    if (!selectedSong) {
      songSelectorState.previewTitle.textContent = songSelectorState.scanInProgress
        ? "正在扫描曲库..."
        : "暂无歌曲";
      stopSongPreview();
      songSelectorState.previewTags.innerHTML = "";
      songSelectorState.previewFallback.textContent = "SW";
      songSelectorState.previewCover.removeAttribute("src");
      songSelectorState.previewCover.style.display = "none";
      songSelectorState.previewBg.style.backgroundImage = "";
      songSelectorState.startButton.disabled = true;
      return;
    }

    songSelectorState.previewTitle.textContent = selectedSong._displayTitle;
    songSelectorState.previewTags.innerHTML = buildTagHtml(
      selectedSong._badges,
    );
    songSelectorState.previewFallback.textContent = selectedSong._coverText;
    songSelectorState.startButton.disabled = false;

    if (selectedSong.coverPath) {
      songSelectorState.previewCover.src = selectedSong.coverPath;
      songSelectorState.previewCover.style.display = "";
      songSelectorState.previewBg.style.backgroundImage =
        'url("' + selectedSong.coverPath.replace(/"/g, "%22") + '")';
    } else {
      songSelectorState.previewCover.removeAttribute("src");
      songSelectorState.previewCover.style.display = "none";
      songSelectorState.previewBg.style.backgroundImage = "";
    }
  }

  function buildSongListItemHtml(song, isActive) {
    return (
      "" +
      '<button type="button" class="song-selector__item' +
      (isActive ? " is-active" : "") +
      '" data-song-key="' +
      escapeHtml(song._selectorKey) +
      '">' +
      '  <span class="song-selector__itemBody">' +
      '    <span class="song-selector__itemTitle">' +
      escapeHtml(song._displayTitle) +
      "</span>" +
      '    <span class="song-selector__itemTags">' +
      buildTagHtml(song._badges) +
      "</span>" +
      "  </span>" +
      "</button>"
    );
  }

  function renderSongList() {
    if (
      !songSelectorState.listViewport ||
      !songSelectorState.listSpacer ||
      !songSelectorState.listItems
    ) {
      return;
    }

    var songs = songSelectorState.filteredSongs;
    songSelectorState.listSpacer.style.height = "0px";

    if (!songs.length) {
      songSelectorState.empty.hidden = false;
      songSelectorState.listItems.innerHTML = "";
      clampSongListScroll();
      return;
    }

    songSelectorState.empty.hidden = true;

    var html = [];

    for (var i = 0; i < songs.length; i++) {
      html.push(
        buildSongListItemHtml(
          songs[i],
          songs[i]._selectorKey === songSelectorState.selectedSongKey,
        ),
      );
    }

    songSelectorState.listItems.innerHTML = html.join("");
    clampSongListScroll();
  }

  function scheduleSongListRender() {
    if (!songSelectorState.root || songSelectorState.renderFrame) {
      return;
    }

    var raf =
      window.requestAnimationFrame ||
      function (callback) {
        return setTimeout(callback, 16);
      };

    songSelectorState.renderFrame = raf(function () {
      songSelectorState.renderFrame = 0;
      renderSongList();
    });
  }

  function scrollSelectedSongIntoView() {
    if (!songSelectorState.listViewport) {
      return;
    }

    var selectedNode = songSelectorState.listItems
      ? songSelectorState.listItems.querySelector(
          '[data-song-key="' +
            songSelectorState.selectedSongKey.replace(/"/g, '\\"') +
            '"]',
        )
      : null;

    if (selectedNode && typeof selectedNode.scrollIntoView === "function") {
      selectedNode.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }
  }

  function setSelectedSongByKey(key, ensureVisible) {
    var selectedSong = findSongByUniqueKey(songSelectorState.orderedSongs, key);
    if (!selectedSong) {
      return;
    }

    var previousKey = songSelectorState.selectedSongKey;
    songSelectorState.selectedSongKey = key;
    updateSongPreview();
    scheduleSongListRender();

    if (ensureVisible) {
      scrollSelectedSongIntoView();
    }

    if (previousKey !== key || !isSongPreviewActive(key)) {
      startSongPreview(selectedSong);
    }
  }

  function applySongFilter(resetScrollTop) {
    var filtered = [];
    var query = songSelectorState.query;

    for (var i = 0; i < songSelectorState.orderedSongs.length; i++) {
      var song = songSelectorState.orderedSongs[i];
      if (!query || song._searchText.indexOf(query) !== -1) {
        filtered.push(song);
      }
    }

    songSelectorState.filteredSongs = filtered;

    if (!findSongByUniqueKey(filtered, songSelectorState.selectedSongKey)) {
      songSelectorState.selectedSongKey = filtered.length
        ? filtered[0]._selectorKey
        : "";
    }

    if (resetScrollTop && songSelectorState.listViewport) {
      songSelectorState.listViewport.scrollTop = 0;
    }

    updateSongSelectorCounts();
    updateSongSelectorStatus();
    updateSongPreview();
    scheduleSongListRender();
  }

  function addSongToSelector(song) {
    var preparedSong = prepareSongForSelector(song);
    if (!preparedSong) {
      return null;
    }

    var existingSong = songSelectorState.songsByKey[preparedSong._selectorKey];
    if (existingSong) {
      return existingSong;
    }

    songSelectorState.songsByKey[preparedSong._selectorKey] = preparedSong;
    songSelectorState.orderedSongs.push(preparedSong);
    discoveredSongs.push(preparedSong);

    if (
      !songSelectorState.query ||
      preparedSong._searchText.indexOf(songSelectorState.query) !== -1
    ) {
      songSelectorState.filteredSongs.push(preparedSong);
    }

    if (
      !songSelectorState.selectedSongKey ||
      songMatchesKey(preparedSong, songSelectorState.requestedKey) ||
      (!songSelectorState.requestedKey &&
        songMatchesKey(preparedSong, songSelectorState.storedKey))
    ) {
      songSelectorState.selectedSongKey = preparedSong._selectorKey;
    }

    updateSongSelectorCounts();
    updateSongSelectorStatus();
    updateSongPreview();
    scheduleSongListRender();

    return preparedSong;
  }

  function startSelectedSong() {
    var selectedSong = findSongByUniqueKey(
      songSelectorState.orderedSongs,
      songSelectorState.selectedSongKey,
    );
    if (!selectedSong) {
      return;
    }

    stopSongPreview();
    applySongSelection(selectedSong);
    storeSelectedSongKey(selectedSong);

    if (songSelectorState.root) {
      songSelectorState.root.classList.add("song-selector--hidden");
    }

    if (document.body.classList) {
      document.body.classList.remove("song-selector-active");
    }

    setPlayerHudVisible(true);
    selectionReadyResolve(selectedSong);
  }

  function startSongSelectionFlow() {
    ensureSongSelectorUI();
    stopSongPreview();
    setPlayerHudVisible(false);
    playbackCompletionQueued = false;

    songSelectorState.requestedKey =
      getUrlParam("song") || getUrlParam("songId") || "";
    songSelectorState.query = "";
    songLibraryStatusMessage = "";

    return rerunSongSelectionFlow({
      keepCurrentSelection: false,
    });
  }

  function createJsonAsset(jsonData) {
    var asset = new cc.JsonAsset();
    asset.json = jsonData;
    return asset;
  }

  function createEmptyAudioAsset() {
    var asset = new cc.AudioClip();
    asset._nativeAsset = new Audio();
    asset._nativeUrl = "";
    return asset;
  }

  var LOCAL_ARROW_EXPORT_ROOTS = ["./arrow/%E5%AF%BC%E5%87%BA/", "./arrow/"];
  var LOCAL_ARROW_ATLAS_JSON_PATH = "./arrow/skin.json";
  var LOCAL_ARROW_ATLAS_IMAGE_PATH = "./arrow/skin.png";
  var LOCAL_ARROW_DIRECTION_MAP = {
    1: "ll",
    2: "lb",
    3: "lt",
    4: "cc",
    5: "rt",
    6: "rb",
    7: "rr",
    8: "tt",
    9: "bb",
  };
  var KNOWN_SKIN_TEXTURE_PATHS = {};
  var SKIN_SPRITEFRAME_CACHE = {};
  var SKIN_SPRITEFRAME_PENDING = {};
  var LOCAL_ARROW_FILE_PENDING = {};
  var LOCAL_ARROW_ATLAS_STATE = {
    framesByName: null,
    texture: null,
    pending: null,
  };
  var BODY_FALLBACK_SUFFIX_MAP = {
    1: 15,
    2: 25,
    3: 35,
    4: 45,
    5: 55,
    6: 65,
    7: 75,
    8: 45,
    9: 45,
  };
  var MASK_FALLBACK_PATH = "skin/pf1/pf1_jiantou_21";
  var REPEAT_FALLBACK_PATH = "skin/pf1/pf1_jiantou_22";
  var TAIL_FALLBACK_PATH = "skin/pf1/pf1_jiantou_23";

  [
    "skin/pf1/pf1_jiantou_15",
    "skin/pf1/pf1_jiantou_25",
    "skin/pf1/pf1_jiantou_35",
    "skin/pf1/pf1_jiantou_45",
    "skin/pf1/pf1_jiantou_55",
    "skin/pf1/pf1_jiantou_65",
    "skin/pf1/pf1_jiantou_75",
    MASK_FALLBACK_PATH,
    REPEAT_FALLBACK_PATH,
    TAIL_FALLBACK_PATH,
    "skin/pf4_ql1/pf4_ql1_jiantou_15",
    "skin/pf4_ql1/pf4_ql1_jiantou_25",
    "skin/pf4_ql1/pf4_ql1_jiantou_35",
    "skin/pf4_ql1/pf4_ql1_jiantou_45",
    "skin/pf4_ql1/pf4_ql1_jiantou_55",
    "skin/pf4_ql1/pf4_ql1_jiantou_65",
    "skin/pf4_ql1/pf4_ql1_jiantou_75",
    "skin/pf4_ql2/pf4_ql2_jiantou_15",
    "skin/pf4_ql2/pf4_ql2_jiantou_25",
    "skin/pf4_ql2/pf4_ql2_jiantou_35",
    "skin/pf4_ql2/pf4_ql2_jiantou_45",
    "skin/pf4_ql2/pf4_ql2_jiantou_55",
    "skin/pf4_ql2/pf4_ql2_jiantou_65",
    "skin/pf4_ql2/pf4_ql2_jiantou_75",
  ].forEach(function (path) {
    KNOWN_SKIN_TEXTURE_PATHS[path] = true;
  });

  function isSkinSpritePath(path) {
    return /^skin\/(?:pf1|pf4_ql1|pf4_ql2)\//.test(path || "");
  }

  function createVec2(x, y) {
    if (cc.v2) {
      return cc.v2(x, y);
    }
    return new cc.Vec2(x, y);
  }

  function createSize(width, height) {
    if (cc.size) {
      return cc.size(width, height);
    }
    return new cc.Size(width, height);
  }

  function createRect(x, y, width, height) {
    if (cc.rect) {
      return cc.rect(x, y, width, height);
    }
    return new cc.Rect(x, y, width, height);
  }

  function parseLocalArrowInfo(path) {
    var match = /^(skin\/(?:pf1|pf4_ql1|pf4_ql2)\/[^/]*?jiantou_)(\d+)$/.exec(
      path || "",
    );
    if (!match) {
      return null;
    }

    var code = parseInt(match[2], 10);
    var part = null;
    var directionCode = 0;

    if (code >= 1 && code <= 9) {
      part = "body";
      directionCode = code;
    } else if (code >= 11) {
      directionCode = Math.floor(code / 10);
      if (directionCode < 1 || directionCode > 9) {
        return null;
      }

      if (code % 10 === 1) {
        part = "mask";
      } else if (code % 10 === 2) {
        part = "repeat";
      } else if (code % 10 === 3) {
        part = "tail";
      }
    }

    if (!part || !LOCAL_ARROW_DIRECTION_MAP[directionCode]) {
      return null;
    }

    var direction = LOCAL_ARROW_DIRECTION_MAP[directionCode];
    var filename = "arrow_" + part + "_" + direction + ".png";
    var localPaths = [];

    for (var i = 0; i < LOCAL_ARROW_EXPORT_ROOTS.length; i++) {
      localPaths.push(LOCAL_ARROW_EXPORT_ROOTS[i] + filename);
    }

    return {
      filename: filename,
      localPaths: localPaths,
    };
  }

  function getSkinTextureFallbacks(path) {
    var match = /^(skin\/(?:pf1|pf4_ql1|pf4_ql2)\/[^/]*?jiantou_)(\d+)$/.exec(
      path || "",
    );
    var fallbacks = [];

    if (KNOWN_SKIN_TEXTURE_PATHS[path]) {
      return [path];
    }

    if (!match) {
      return [];
    }

    var prefix = match[1];
    var suffix = parseInt(match[2], 10);
    var bodyFallback = BODY_FALLBACK_SUFFIX_MAP[suffix];

    if (bodyFallback) {
      fallbacks.push(prefix + bodyFallback);
    } else if (suffix >= 10) {
      if (suffix % 10 === 1) {
        fallbacks.push(MASK_FALLBACK_PATH);
      } else if (suffix % 10 === 2) {
        fallbacks.push(REPEAT_FALLBACK_PATH);
      } else if (suffix % 10 === 3) {
        fallbacks.push(TAIL_FALLBACK_PATH);
      }
    }

    var filtered = [];
    for (var i = 0; i < fallbacks.length; i++) {
      if (KNOWN_SKIN_TEXTURE_PATHS[fallbacks[i]]) {
        filtered.push(fallbacks[i]);
      }
    }

    return uniquePaths(filtered);
  }

  function loadTextureFromImageUrl(url, callback) {
    var image = new Image();
    var runtimeUrl = getEmbeddedLocalNativeAssetUrl(url) || url;

    image.onload = function () {
      var texture = new cc.Texture2D();

      if (texture.initWithElement) {
        texture.initWithElement(image);
        if (texture.handleLoadedTexture) {
          texture.handleLoadedTexture();
        }
      } else {
        texture._nativeAsset = image;
        texture.url = url;
      }

      callback(null, texture);
    };

    image.onerror = function () {
      callback(new Error("Failed to load image: " + runtimeUrl));
    };

    image.src = runtimeUrl;
  }

  function createSpriteFrameFromTexture(texture, name, atlasFrame) {
    var spriteFrame = new cc.SpriteFrame();

    if (atlasFrame && atlasFrame.frame) {
      var frameRect = createRect(
        atlasFrame.frame.x,
        atlasFrame.frame.y,
        atlasFrame.frame.w,
        atlasFrame.frame.h,
      );
      var originalSize = createSize(
        atlasFrame.sourceSize && atlasFrame.sourceSize.w
          ? atlasFrame.sourceSize.w
          : atlasFrame.frame.w,
        atlasFrame.sourceSize && atlasFrame.sourceSize.h
          ? atlasFrame.sourceSize.h
          : atlasFrame.frame.h,
      );
      var offset = createVec2(0, 0);

      if (spriteFrame.setTexture) {
        try {
          spriteFrame.setTexture(
            texture,
            frameRect,
            !!atlasFrame.rotated,
            offset,
            originalSize,
          );
        } catch (err) {
          spriteFrame.setTexture(texture);
          if (spriteFrame.setRect) {
            spriteFrame.setRect(frameRect);
          }
          if (spriteFrame.setOriginalSize) {
            spriteFrame.setOriginalSize(originalSize);
          }
          if (spriteFrame.setOffset) {
            spriteFrame.setOffset(offset);
          }
        }
      } else if (spriteFrame.initWithTexture) {
        spriteFrame.initWithTexture(texture, frameRect);
      } else {
        spriteFrame._texture = texture;
      }
    } else if (spriteFrame.setTexture) {
      spriteFrame.setTexture(texture);
    } else if (spriteFrame.initWithTexture) {
      spriteFrame.initWithTexture(texture);
    } else {
      spriteFrame._texture = texture;
    }

    spriteFrame.name = stripExtension((name || "").split("/").pop());
    return spriteFrame;
  }

  function loadStandaloneArrowSpriteFrame(path, displayName, callback) {
    var cacheKey = "file:" + path;

    if (SKIN_SPRITEFRAME_CACHE[cacheKey]) {
      setTimeout(function () {
        callback(null, SKIN_SPRITEFRAME_CACHE[cacheKey]);
      }, 0);
      return;
    }

    if (LOCAL_ARROW_FILE_PENDING[cacheKey]) {
      LOCAL_ARROW_FILE_PENDING[cacheKey].push(callback);
      return;
    }

    LOCAL_ARROW_FILE_PENDING[cacheKey] = [callback];

    loadTextureFromImageUrl(path, function (err, texture) {
      var listeners = LOCAL_ARROW_FILE_PENDING[cacheKey] || [];
      delete LOCAL_ARROW_FILE_PENDING[cacheKey];

      var spriteFrame = null;
      if (!err && texture) {
        spriteFrame = createSpriteFrameFromTexture(texture, displayName);
        SKIN_SPRITEFRAME_CACHE[cacheKey] = spriteFrame;
      }

      for (var i = 0; i < listeners.length; i++) {
        listeners[i](err, spriteFrame);
      }
    });
  }

  function loadLocalArrowFromFiles(arrowInfo, callback) {
    function tryNext(index) {
      if (!arrowInfo || index >= arrowInfo.localPaths.length) {
        callback(
          new Error(
            "Local arrow file not found for: " +
              (arrowInfo ? arrowInfo.filename : "unknown"),
          ),
        );
        return;
      }

      loadStandaloneArrowSpriteFrame(
        arrowInfo.localPaths[index],
        arrowInfo.filename,
        function (err, spriteFrame) {
          if (!err && spriteFrame) {
            callback(null, spriteFrame);
            return;
          }

          console.warn(
            "Local arrow file load failed:",
            arrowInfo.localPaths[index],
            err,
          );
          tryNext(index + 1);
        },
      );
    }

    tryNext(0);
  }

  function ensureLocalArrowAtlas(callback) {
    if (
      LOCAL_ARROW_ATLAS_STATE.framesByName &&
      LOCAL_ARROW_ATLAS_STATE.texture
    ) {
      setTimeout(function () {
        callback(null, LOCAL_ARROW_ATLAS_STATE);
      }, 0);
      return;
    }

    if (LOCAL_ARROW_ATLAS_STATE.pending) {
      LOCAL_ARROW_ATLAS_STATE.pending.push(callback);
      return;
    }

    LOCAL_ARROW_ATLAS_STATE.pending = [callback];

    function finish(err) {
      var listeners = LOCAL_ARROW_ATLAS_STATE.pending || [];
      LOCAL_ARROW_ATLAS_STATE.pending = null;

      for (var i = 0; i < listeners.length; i++) {
        listeners[i](err, err ? null : LOCAL_ARROW_ATLAS_STATE);
      }
    }

    loadTextFromPath(LOCAL_ARROW_ATLAS_JSON_PATH)
      .then(function (text) {
        var data = JSON.parse(text);
        var frames = data.frames || [];
        var framesByName = {};

        for (var i = 0; i < frames.length; i++) {
          if (frames[i] && frames[i].filename) {
            framesByName[frames[i].filename] = frames[i];
          }
        }

        LOCAL_ARROW_ATLAS_STATE.framesByName = framesByName;

        loadTextureFromImageUrl(
          LOCAL_ARROW_ATLAS_IMAGE_PATH,
          function (err, texture) {
            if (err || !texture) {
              finish(
                err || new Error("Failed to load local arrow atlas texture"),
              );
              return;
            }

            LOCAL_ARROW_ATLAS_STATE.texture = texture;
            finish(null);
          },
        );
      })
      .catch(function (err) {
        finish(err);
      });
  }

  function loadLocalArrowFromAtlas(arrowInfo, callback) {
    var cacheKey = "atlas:" + (arrowInfo ? arrowInfo.filename : "");

    if (SKIN_SPRITEFRAME_CACHE[cacheKey]) {
      setTimeout(function () {
        callback(null, SKIN_SPRITEFRAME_CACHE[cacheKey]);
      }, 0);
      return;
    }

    ensureLocalArrowAtlas(function (err, atlasState) {
      if (
        err ||
        !atlasState ||
        !atlasState.framesByName ||
        !atlasState.texture
      ) {
        callback(err || new Error("Local arrow atlas is not available"));
        return;
      }

      var atlasFrame = atlasState.framesByName[arrowInfo.filename];
      if (!atlasFrame) {
        callback(
          new Error("Arrow atlas frame not found: " + arrowInfo.filename),
        );
        return;
      }

      var spriteFrame = createSpriteFrameFromTexture(
        atlasState.texture,
        arrowInfo.filename,
        atlasFrame,
      );
      SKIN_SPRITEFRAME_CACHE[cacheKey] = spriteFrame;
      callback(null, spriteFrame);
    });
  }

  function loadTextureFromResources(path, callback) {
    var resourcesBundle =
      cc.resources ||
      (cc.assetManager &&
        cc.assetManager.getBundle &&
        cc.assetManager.getBundle("resources"));
    if (!resourcesBundle || typeof resourcesBundle.load !== "function") {
      callback(
        new Error("Resources bundle is not ready for skin fallback loading"),
      );
      return;
    }

    resourcesBundle.load(path, cc.Texture2D, function (err, texture) {
      callback(err, texture);
    });
  }

  function loadSkinSpriteFrame(path, callback) {
    if (SKIN_SPRITEFRAME_CACHE[path]) {
      setTimeout(function () {
        callback(null, SKIN_SPRITEFRAME_CACHE[path]);
      }, 0);
      return;
    }

    if (SKIN_SPRITEFRAME_PENDING[path]) {
      SKIN_SPRITEFRAME_PENDING[path].push(callback);
      return;
    }

    SKIN_SPRITEFRAME_PENDING[path] = [callback];

    function finish(err, spriteFrame) {
      var listeners = SKIN_SPRITEFRAME_PENDING[path] || [];
      delete SKIN_SPRITEFRAME_PENDING[path];

      if (!err && spriteFrame) {
        SKIN_SPRITEFRAME_CACHE[path] = spriteFrame;
      }

      for (var i = 0; i < listeners.length; i++) {
        if (listeners[i]) {
          listeners[i](err, spriteFrame);
        }
      }
    }

    function loadFromResourcesFallback() {
      var candidatePaths = getSkinTextureFallbacks(path);
      if (!candidatePaths.length) {
        finish(new Error("No local skin fallback path for: " + path));
        return;
      }

      function tryNext(index) {
        if (index >= candidatePaths.length) {
          finish(
            new Error("All local skin fallback paths failed for: " + path),
          );
          return;
        }

        var candidatePath = candidatePaths[index];
        var cachedSpriteFrame = SKIN_SPRITEFRAME_CACHE[candidatePath];
        if (cachedSpriteFrame) {
          finish(null, cachedSpriteFrame);
          return;
        }

        loadTextureFromResources(candidatePath, function (err, texture) {
          if (err || !texture) {
            console.warn(
              "Skin fallback texture load failed:",
              candidatePath,
              err,
            );
            tryNext(index + 1);
            return;
          }

          var spriteFrame = createSpriteFrameFromTexture(
            texture,
            candidatePath,
          );
          SKIN_SPRITEFRAME_CACHE[candidatePath] = spriteFrame;
          finish(null, spriteFrame);
        });
      }

      tryNext(0);
    }

    var localArrowInfo = parseLocalArrowInfo(path);
    if (localArrowInfo) {
      loadLocalArrowFromFiles(
        localArrowInfo,
        function (fileErr, fileSpriteFrame) {
          if (!fileErr && fileSpriteFrame) {
            finish(null, fileSpriteFrame);
            return;
          }

          console.warn(
            "Local split arrow load failed, trying atlas:",
            localArrowInfo.filename,
            fileErr,
          );
          loadLocalArrowFromAtlas(
            localArrowInfo,
            function (atlasErr, atlasSpriteFrame) {
              if (!atlasErr && atlasSpriteFrame) {
                finish(null, atlasSpriteFrame);
                return;
              }

              console.warn(
                "Local arrow atlas load failed, trying bundled fallback:",
                localArrowInfo.filename,
                atlasErr,
              );
              loadFromResourcesFallback();
            },
          );
        },
      );
      return;
    }

    loadFromResourcesFallback();
  }

  function loadJsonFromPaths(paths, callback) {
    if (currentSong && currentSong.chartData) {
      callback(
        createJsonAsset(currentSong.chartData),
        currentSong.chartPath || "embedded-manifest",
      );
      return;
    }

    function tryNext(index) {
      if (index >= paths.length) {
        console.warn(
          "All local chart paths failed, using empty fallback chart",
        );
        callback(createJsonAsset(EMPTY_CHART_DATA), "");
        return;
      }

      var path = paths[index];
      var xhr = new XMLHttpRequest();
      xhr.open("GET", path, true);
      xhr.responseType = "json";

      xhr.onload = function () {
        if (isSuccessfulRequestStatus(xhr, path) && xhr.response) {
          callback(createJsonAsset(xhr.response), path);
        } else {
          console.warn(
            "Failed to load chart from:",
            path,
            "status:",
            xhr.status,
          );
          tryNext(index + 1);
        }
      };

      xhr.onerror = function () {
        console.warn("XHR error loading chart from:", path);
        tryNext(index + 1);
      };

      xhr.send();
    }

    tryNext(0);
  }

  function loadAudioFromPaths(paths, callback) {
    function useHtmlAudio(path, next) {
      var settled = false;
      var audio = new Audio();
      audio.preload = "auto";

      function finalize() {
        if (settled) {
          return;
        }

        settled = true;
        var asset = new cc.AudioClip();
        asset._nativeAsset = audio;
        asset._nativeUrl = path;
        bindCurrentAudioElement(audio);
        callback(asset, path);
      }

      audio.addEventListener("loadedmetadata", finalize, { once: true });
      audio.addEventListener("canplay", finalize, { once: true });
      audio.addEventListener("canplaythrough", finalize, { once: true });

      audio.addEventListener(
        "error",
        function () {
          if (settled) {
            return;
          }
          settled = true;
          next();
        },
        { once: true },
      );

      audio.src = path;
      audio.load();
    }

    function tryNext(index) {
      if (index >= paths.length) {
        console.warn("All local audio paths failed, using empty audio clip");
        callback(createEmptyAudioAsset(), "");
        return;
      }

      var path = paths[index];
      useHtmlAudio(path, function () {
        cc.loader.load(path, function (err, result) {
          if (!err) {
            var asset = new cc.AudioClip();
            asset._nativeAsset = result;
            asset._nativeUrl = path;
            callback(asset, path);
            return;
          }

          console.warn("cc.loader failed for audio path:", path, err);
          tryNext(index + 1);
        });
      });
    }

    tryNext(0);
  }

  function initLocalAdapter() {
    installEarlyLocalNativeAssetPatch();
    installEarlyLocalFileXHRPatch();
    preferDomImagePipelineForLocalFile();

    if (typeof cc === "undefined" || !cc.assetManager) {
      console.log("Cocos not loaded yet, retrying...");
      setTimeout(initLocalAdapter, 100);
      return;
    }

    console.log("Initializing local adapter...");
    preferDomImagePipelineForLocalFile();
    var originalLoadRemote = cc.assetManager.loadRemote;
    var originalXHR = window.XMLHttpRequest;
    var originalLoadRes = cc.loader && cc.loader.loadRes;
    var originalStatusDescriptor = Object.getOwnPropertyDescriptor(
      originalXHR.prototype,
      "status",
    );
    var originalStatusTextDescriptor = Object.getOwnPropertyDescriptor(
      originalXHR.prototype,
      "statusText",
    );

    if (cc.loader && typeof originalLoadRes === "function") {
      cc.loader.loadRes = function (url, type, callback) {
        var assetType = type;
        var completed = callback;

        if (assetType === cc.SpriteFrame && isSkinSpritePath(url)) {
          loadSkinSpriteFrame(url, function (err, spriteFrame) {
            if (err) {
              console.warn("Skin sprite fallback failed for:", url, err);
            }
            if (completed) {
              completed(err, spriteFrame || null);
            }
          });
          return;
        }

        if (typeof type === "function" && callback === undefined) {
          completed = type;
          assetType = null;
        }

        return originalLoadRes.apply(cc.loader, arguments);
      };
    }

    cc.assetManager.loadRemote = function (url, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }

      if (url === "local://chart") {
        selectionReadyPromise.then(function () {
          var chartPaths = uniquePaths(
            [currentSongPath].concat(ROOT_CHART_FALLBACKS),
          );
          console.log("Loading local chart from:", chartPaths);
          loadJsonFromPaths(chartPaths, function (asset, path) {
            if (path) {
              console.log("Loaded chart from:", path);
            }
            if (callback) {
              callback(null, asset);
            }
          });
        });
        return;
      }

      if (url === "local://audio") {
        selectionReadyPromise.then(function () {
          var audioPaths = uniquePaths(
            [currentMusicPath].concat(ROOT_AUDIO_FALLBACKS),
          );
          console.log("Loading local audio from:", audioPaths);
          loadAudioFromPaths(audioPaths, function (asset, path) {
            if (path) {
              console.log("Loaded audio from:", path);
            }
            if (callback) {
              callback(null, asset);
            }
          });
        });
        return;
      }

      return originalLoadRemote.call(cc.assetManager, url, options, callback);
    };

    window.XMLHttpRequest = function () {
      var xhr = new originalXHR();
      var originalOpen = xhr.open;
      var originalSend = xhr.send;

      try {
        Object.defineProperty(xhr, "status", {
          configurable: true,
          get: function () {
            var status =
              originalStatusDescriptor && originalStatusDescriptor.get
                ? originalStatusDescriptor.get.call(this)
                : 0;

            if (status === 0 && isSuccessfulLocalFileRequest(this)) {
              return 200;
            }

            return status;
          },
        });

        Object.defineProperty(xhr, "statusText", {
          configurable: true,
          get: function () {
            if (this.status === 200 && window.location.protocol === "file:") {
              return "OK";
            }

            return originalStatusTextDescriptor &&
              originalStatusTextDescriptor.get
              ? originalStatusTextDescriptor.get.call(this)
              : "";
          },
        });
      } catch (err) {}

      xhr.open = function (method, url, async, user, password) {
        this._url = url;
        if (url.indexOf("/api/external/sptrm/getSmInfo") !== -1) {
          this._isApiIntercepted = true;
        }
        return originalOpen.apply(this, arguments);
      };

      xhr.send = function (body) {
        if (this._isApiIntercepted) {
          setTimeout(function () {
            var mockResponse = {
              code: 0,
              data: {
                smPublicUrl: "local://chart",
                cdnUrl: "local://audio",
              },
            };

            Object.defineProperty(xhr, "response", {
              get: function () {
                return JSON.stringify(mockResponse);
              },
              set: function () {},
            });
            Object.defineProperty(xhr, "responseText", {
              get: function () {
                return JSON.stringify(mockResponse);
              },
              set: function () {},
            });
            Object.defineProperty(xhr, "status", {
              get: function () {
                return 200;
              },
              set: function () {},
            });
            Object.defineProperty(xhr, "readyState", {
              get: function () {
                return 4;
              },
              set: function () {},
            });

            if (xhr.onreadystatechange) {
              xhr.onreadystatechange();
            }
            if (xhr.onload) {
              xhr.onload();
            }
          }, 50);
          return;
        }

        return originalSend.apply(this, arguments);
      };

      return xhr;
    };

    window.XMLHttpRequest.prototype = originalXHR.prototype;
    window.XMLHttpRequest.UNSENT = originalXHR.UNSENT;
    window.XMLHttpRequest.OPENED = originalXHR.OPENED;
    window.XMLHttpRequest.HEADERS_RECEIVED = originalXHR.HEADERS_RECEIVED;
    window.XMLHttpRequest.LOADING = originalXHR.LOADING;
    window.XMLHttpRequest.DONE = originalXHR.DONE;

    console.log("Local adapter initialized successfully");
  }

  installEarlyLocalNativeAssetPatch();
  installEarlyLocalFileXHRPatch();
  preferDomImagePipelineForLocalFile();
  window.addEventListener("beforeunload", function () {
    revokePickedSongObjectUrls();
  });
  startSongSelectionFlow();
  initLocalAdapter();
})();
