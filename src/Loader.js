//////////////////////////////////////////////////////////////////////////////////////
//
//  The MIT License (MIT)
//
//  Copyright (c) 2017-present, Dom Chen
//  All rights reserved.
//
//  Permission is hereby granted, free of charge, to any person obtaining a copy of
//  this software and associated documentation files (the "Software"), to deal in the
//  Software without restriction, including without limitation the rights to use, copy,
//  modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
//  and to permit persons to whom the Software is furnished to do so, subject to the
//  following conditions:
//
//      The above copyright notice and this permission notice shall be included in all
//      copies or substantial portions of the Software.
//
//  THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//  INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//  PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
//  HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
//  OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
//  SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
//////////////////////////////////////////////////////////////////////////////////////

const fs = require('fs');
const http = require('follow-redirects').http;
const https = require('follow-redirects').https;
const path = require("path");
const AdmZip = require('adm-zip');
const ProgressBar = require("progress");
const File = require('./File')
const terminal = require('./Terminal')

function getEntryName(entry) {
    let entryName = entry.entryName.toString();
    if (entryName.substr(0, 8) === "__MACOSX" || entryName.substr(entryName.length - 9, 9) === ".DS_Store") {
        return "";
    }
    return entryName;
}

function unzipFile(filePath, dir) {
    terminal.log("【depsync】unzipping file: " + filePath);
    let zip = new AdmZip(filePath);
    let entries = zip.getEntries();
    let rootNames = [];
    for (let entry of entries) {
        let entryName = getEntryName(entry);
        if (!entryName) {
            continue;
        }
        let name = entryName.split("\\").join("/").split("/")[0];
        if (rootNames.indexOf(name) === -1) {
            rootNames.push(name);
        }
    }
    for (let name of rootNames) {
        let targetPath = path.resolve(dir, name);
        File.deletePath(targetPath);
    }
    for (let entry of entries) {
        let entryName = getEntryName(entry);
        if (!entryName) {
            continue;
        }
        let targetPath = path.resolve(dir, entryName);
        if (entry.isDirectory) {
            File.createDirectory(targetPath);
            continue;
        }
        let content = entry.getData();
        if (!content) {
            throw new Error("Cannot unzip file:" + filePath);
        }
        File.writeFile(targetPath, content);
    }
    File.deletePath(filePath);
}

function loadMultiParts(urls, filePath, callback) {
    if (urls.length === 0) {
        callback && callback();
        return;
    }
    let url = urls.shift();
    loadSingleFile(url, filePath, function (error) {
        if (error) {
            callback && callback(error);
            return;
        }
        loadMultiParts(urls, filePath, callback);
    }, {flags: 'a'});
}

function loadSingleFile(url, filePath, callback, options) {
    let retryTimes = 0;
    terminal.saveCursor();
    terminal.log("【depsync】downloading file: " + url);
    loadSingleFileWithTimeOut(url, filePath, onFinish, options);

    function onFinish(error) {
        terminal.restoreCursorAndClear();
        if (error && error.message === "timeout" && retryTimes < 3) {
            retryTimes++;
            terminal.saveCursor();
            terminal.log("downloading file retry " + retryTimes + ": " + url);
            loadSingleFileWithTimeOut(url, filePath, onFinish, options);
        } else {
            callback(error);
        }
    }
}

function loadSingleFileWithTimeOut(url, filePath, callback, options) {
    let httpClient = url.slice(0, 5) === 'https' ? https : http;
    try {
        File.createDirectory(path.dirname(filePath));
    } catch (e) {
        terminal.log("Cannot create directory: " + path.dirname(filePath));
        process.exit(1);
    }
    let file = fs.createWriteStream(filePath, options);
    let outputError;
    let hasProgressBar = false;
    file.on("close", function () {
        callback && callback(outputError);
    });
    let request = httpClient.get(url, function (response) {
        if (response.statusCode >= 400 || response.statusCode === 0) {
            file.close();
            outputError = new Error(response.statusMessage);
            return;
        }
        let length = parseInt(response.headers['content-length'], 10);
        let complete = process.platform === "win32" ? "#" : '█';
        let incomplete = process.platform === "win32" ? "=" : '░';
        let bar = new ProgressBar(':bar [ :percent | :current/:total | :etas ] ', {
            complete: complete,
            incomplete: incomplete,
            width: 80,
            total: length,
            clear: true
        });
        hasProgressBar = true;
        response.on('data', function (chunk) {
            file.write(chunk);
            bar.tick(chunk.length);
        });
        response.on('end', function () {
            file.end();
        });
        response.on('error', function (error) {
            file.close();
            outputError = error;
        });
        request.setTimeout(15000, function () {
            request.abort();
            file.close();
            outputError = new Error("timeout");
        });
    });
}


function downloadFiles(list, callback) {
    if (list.length === 0) {
        callback && callback();
        return;
    }
    let item = list.shift();
    let fileName = item.url.split("?")[0];
    let filePath = path.resolve(item.dir, path.basename(fileName));
    File.deletePath(filePath);
    if (item.multipart) {
        let urls = [];
        for (let tail of item.multipart) {
            urls.push(item.url + tail);
        }
        loadMultiParts(urls, filePath, onFinish);
    } else {
        loadSingleFile(item.url, filePath, onFinish);
    }

    function onFinish(error) {
        if (error) {
            terminal.log("【depsync】downloading: " + item.url);
            terminal.log("Cannot download file : " + error.message);
            process.exit(1);
            return;
        }
        if (item.unzip) {
            try {
                terminal.saveCursor();
                unzipFile(filePath, item.dir);
                terminal.restoreCursorAndClear();
            } catch (e) {
                terminal.log("Cannot unzip file: " + filePath);
                process.exit(1);
            }
        }
        File.writeHash(item);
        downloadFiles(list, callback);
    }
}

exports.downloadFiles = downloadFiles;