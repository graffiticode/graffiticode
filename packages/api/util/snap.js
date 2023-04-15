"use strict";
function waitFor(testFx, onReady, timeOutMillis) {
  const maxtimeOutMillis = timeOutMillis || 3000; // < Default Max Timout is 3s
  const start = new Date().getTime();
  let condition = false;
  var interval = setInterval(function () {
    if ((new Date().getTime() - start < maxtimeOutMillis) && !condition) {
      // If not time-out yet and condition not yet fulfilled
      condition = (typeof (testFx) === "string" ? eval(testFx) : testFx()); // < defensive code
    } else {
      if (!condition) {
        // If condition still not fulfilled (timeout but condition is 'false')
        console.log("'waitFor()' timeout");
        phantom.exit(1);
      } else {
        // Condition fulfilled (timeout and/or condition is 'true')
        console.log("'waitFor()' finished in " + (new Date().getTime() - start) + "ms.");
        typeof (onReady) === "string" ? eval(onReady) : onReady(); // < Do what it's supposed to do once the condition is fulfilled
        clearInterval(interval); // < Stop this interval
      }
    }
  }, 250); // < repeat check every 250ms
};
const page = require("webpage").create();
page.viewportSize = { width: 265, height: 144 };
page.onConsoleMessage = function (msg, lineNum, sourceID) {
  console.log("CONSOLE " + msg);
};
page.onError = function (msg, trace) {
  const msgStack = ["ERROR: " + msg];

  if (trace && trace.length) {
    msgStack.push("TRACE:");
    trace.forEach(function (t) {
      msgStack.push(" -> " + t.file + ": " + t.line + (t.function ? " (in function \"" + t.function + "\")" : ""));
    });
  }

  console.error(msgStack.join("\n"));
};

page.onResourceError = function (resourceError) {
  console.log("Unable to load resource (#" + resourceError.id + "URL:" + resourceError.url + ")");
  console.log("Error code: " + resourceError.errorCode + ". Description: " + resourceError.errorString);
};
page.onResourceTimeout = function (request) {
  console.log("Response (#" + request.id + "): " + JSON.stringify(request));
};
// page.zoomFactor = 4;
console.log("settings=" + JSON.stringify(page.settings));
const t0 = new Date();
page.open("https://acx.ac/s/JePIZ7g4fx", function () {
// page.open('http://www.google.com', function() {
  console.log("hello");
  function checkLoaded(t0) {
    const td = new Date() - t0;
    if (td > 10000) {
      console.log("Aborting. Page taking too long to load.");
      phantom.exit();
      return;
    }
    const isLoaded = page.content.indexOf("svg") > 0;
    console.log("isLoaded=" + isLoaded);
    if (isLoaded) {
      // var graffView = window.document.querySelector("#graff-view");
      // var img = graffView.outerHTML;
      // var ids = decodeID(id);
      // var lang = "L" + langName(ids[0]);
      // setCache(lang, id, "snap", img);
      // window.close();
      // resume(null, img);
      console.log("Snap scraped in " + td + "ms");
      phantom.exit();
    } else {
      console.log(page.content);
      window.setTimeout(function () {
        checkLoaded(t0);
      }, 100);
    }
  };
  checkLoaded(t0);
});
