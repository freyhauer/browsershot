const fs = require('fs');
const URL = require('url').URL;
const URLParse = require('url').parse;

const [, , ...args] = process.argv;

/**
 * There are two ways for Browsershot to communicate with puppeteer:
 * - By giving a options JSON dump as an argument
 * - Or by providing a temporary file with the options JSON dump,
 *   the path to this file is then given as an argument with the flag -f
 */
const request = args[0].startsWith('-f ')
    ? JSON.parse(fs.readFileSync(new URL(args[0].substring(3))))
    : JSON.parse(args[0]);

const requestsList = [];

const consoleMessages = [];

const failedRequests = [];

const getOutput = async (page, request) => {
    let output;

    if (request.action == 'requestsList') {
        output = JSON.stringify(requestsList);

        return output;
    }

    if (request.action == 'consoleMessages') {
        output = JSON.stringify(consoleMessages);

        return output;
    }

    if (request.action == 'failedRequests') {
        output = JSON.stringify(failedRequests);

        return output;
    }

    if (request.action == 'evaluate') {
        output = await page.evaluate(request.options.pageFunction);

        return output;
    }

    output = await page[request.action](request.options);

    return output.toString('base64');
};

const callChrome = async pup => {
    let browser;
    let page;
    let output;
    let remoteInstance;
    const puppet = (pup || require('puppeteer'));

    try {
        if (request.options.remoteInstanceUrl || request.options.browserWSEndpoint ) {
            // default options
            let options = {
                ignoreHTTPSErrors: request.options.ignoreHttpsErrors
            };

            // choose only one method to connect to the browser instance
            if ( request.options.remoteInstanceUrl ) {
                options.browserURL = request.options.remoteInstanceUrl;
            } else if ( request.options.browserWSEndpoint ) {
                options.browserWSEndpoint = request.options.browserWSEndpoint;
            }

            try {
                browser = await puppet.connect( options );

                remoteInstance = true;
            } catch (exception) { /** does nothing. fallbacks to launching a chromium instance */}
        }

        if (!browser) {
            browser = await puppet.launch({
                ignoreHTTPSErrors: request.options.ignoreHttpsErrors,
                executablePath: request.options.executablePath,
                args: request.options.args || [],
                pipe: request.options.pipe || false,
                env: {
                    ...(request.options.env || {}),
                    ...process.env
                },
            });
        }

        page = await browser.newPage();

        if (request.options && request.options.disableJavascript) {
            await page.setJavaScriptEnabled(false);
        }

        await page.setRequestInterception(true);

        if (request.postParams) {
            const postParamsArray = request.postParams;
            const queryString = Object.keys(postParamsArray)
                .map(key => `${key}=${postParamsArray[key]}`)
                .join('&');
            page.once("request", interceptedRequest => {
                interceptedRequest.continue({
                    method: "POST",
                    postData: queryString,
                    headers: {
                        ...interceptedRequest.headers(),
                        "Content-Type": "application/x-www-form-urlencoded"
                    }
                });
            });
        }

        const contentUrl = request.options.contentUrl;
        const parsedContentUrl = contentUrl ? contentUrl.replace(/\/$/, "") : undefined;
        let pageContent;

        if (contentUrl) {
            pageContent = fs.readFileSync(request.url.replace('file://', ''));
            request.url = contentUrl;
        }

        page.on('console',  message => consoleMessages.push({
            type: message.type(),
            message: message.text(),
            location: message.location()
        }));

        page.on('response', function (response) {
            if (response.status() >= 200 && response.status() <= 399) {
                return;
            }

            failedRequests.push({
                status: response.status(),
                url: response.url(),
            });
        })

        page.on('request', interceptedRequest => {
            var headers = interceptedRequest.headers();

            requestsList.push({
                url: interceptedRequest.url(),
            });

            if (request.options && request.options.disableImages) {
                if (interceptedRequest.resourceType() === 'image') {
                    interceptedRequest.abort();
                    return;
                }
            }

            if (request.options && request.options.blockDomains) {
                const hostname = URLParse(interceptedRequest.url()).hostname;
                if (request.options.blockDomains.includes(hostname)) {
                    interceptedRequest.abort();
                    return;
                }
            }

            if (request.options && request.options.blockUrls) {
                for (const element of request.options.blockUrls) {
                    if (interceptedRequest.url().indexOf(element) >= 0) {
                        interceptedRequest.abort();
                        return;
                    }
                }
            }

            if (request.options && request.options.extraNavigationHTTPHeaders) {
                // Do nothing in case of non-navigation requests.
                if (interceptedRequest.isNavigationRequest()) {
                    headers = Object.assign({}, headers, request.options.extraNavigationHTTPHeaders);
                }
            }

            if (pageContent) {
                const interceptedUrl = interceptedRequest.url().replace(/\/$/, "");

                // if content url matches the intercepted request url, will return the content fetched from the local file system
                if (interceptedUrl === parsedContentUrl) {
                    interceptedRequest.respond({
                        headers,
                        body: pageContent,
                    });
                    return;
                }
            }

            interceptedRequest.continue({ headers });
        });

        if (request.options && request.options.dismissDialogs) {
            page.on('dialog', async dialog => {
                await dialog.dismiss();
            });
        }

        if (request.options && request.options.userAgent) {
            await page.setUserAgent(request.options.userAgent);
        }

        if (request.options && request.options.device) {
            const devices = puppet.devices;
            const device = devices[request.options.device];
            await page.emulate(device);
        }

        if (request.options && request.options.emulateMedia) {
            await page.emulateMediaType(request.options.emulateMedia);
        }

        if (request.options && request.options.viewport) {
            await page.setViewport(request.options.viewport);
        }

        if (request.options && request.options.extraHTTPHeaders) {
            await page.setExtraHTTPHeaders(request.options.extraHTTPHeaders);
        }

        if (request.options && request.options.authentication) {
            await page.authenticate(request.options.authentication);
        }

        if (request.options && request.options.cookies) {
            await page.setCookie(...request.options.cookies);
        }

        if (request.options && request.options.timeout) {
            await page.setDefaultNavigationTimeout(request.options.timeout);
        }

        const requestOptions = {};

        if (request.options && request.options.networkIdleTimeout) {
            requestOptions.waitUntil = 'networkidle';
            requestOptions.networkIdleTimeout = request.options.networkIdleTimeout;
        } else if (request.options && request.options.waitUntil) {
            requestOptions.waitUntil = request.options.waitUntil;
        }

        const response = await page.goto(request.url, requestOptions);

        if (request.options.preventUnsuccessfulResponse) {
            const status = response.status()

            if (status >= 400 && status < 600) {
                throw {type: "UnsuccessfulResponse", status};
            }
        }

        if (request.options && request.options.disableImages) {
            await page.evaluate(() => {
                let images = document.getElementsByTagName('img');
                while (images.length > 0) {
                    images[0].parentNode.removeChild(images[0]);
                }
            });
        }

        if (request.options && request.options.types) {
            for (let i = 0, len = request.options.types.length; i < len; i++) {
                let typeOptions = request.options.types[i];
                await page.type(typeOptions.selector, typeOptions.text, {
                    'delay': typeOptions.delay,
                });
            }
        }

        if (request.options && request.options.selects) {
            for (let i = 0, len = request.options.selects.length; i < len; i++) {
                let selectOptions = request.options.selects[i];
                await page.select(selectOptions.selector, selectOptions.value);
            }
        }

        if (request.options && request.options.clicks) {
            for (let i = 0, len = request.options.clicks.length; i < len; i++) {
                let clickOptions = request.options.clicks[i];
                await page.click(clickOptions.selector, {
                    'button': clickOptions.button,
                    'clickCount': clickOptions.clickCount,
                    'delay': clickOptions.delay,
                });
            }
        }

        if (request.options && request.options.addStyleTag) {
            await page.addStyleTag(JSON.parse(request.options.addStyleTag));
        }

        if (request.options && request.options.pagedjs) {
            await page.evaluate(() => {
                window.PagedConfig = window.PagedConfig || {};
                window.PagedConfig.auto = false;
            });
            
            await page.addScriptTag({
				url: request.options.pagedjs
			});
        }

        if (request.options && request.options.addScriptTag) {
            await page.addScriptTag(JSON.parse(request.options.addScriptTag));
        }

        if (request.options && request.options.pagedjs) {
            await page.exposeFunction("onSize", (size) => {
                this.emit("size", size);
            });
    
            await page.exposeFunction("onPage", (page) => {
    
                this.pages.push(page);
    
                this.emit("page", page);
            });
    
            await page.exposeFunction("onRendered", (msg, width, height, orientation) => {
                this.emit("rendered", msg, width, height, orientation);
                resolver({msg, width, height, orientation});
            });
    
            await page.evaluate(async () => {
                let done;
                window.PagedPolyfill.on("page", (page) => {
                    const { id, width, height, startToken, endToken, breakAfter, breakBefore, position } = page;
    
                    const mediabox = page.element.getBoundingClientRect();
                    const cropbox = page.pagebox.getBoundingClientRect();
    
                    function getPointsValue(value) {
                        return (Math.round(CSS.px(value).to("pt").value * 100) / 100);
                    }
    
                    let boxes = {
                        media: {
                            width: getPointsValue(mediabox.width),
                            height: getPointsValue(mediabox.height),
                            x: 0,
                            y: 0
                        },
                        crop: {
                            width: getPointsValue(cropbox.width),
                            height: getPointsValue(cropbox.height),
                            x: getPointsValue(cropbox.x) - getPointsValue(mediabox.x),
                            y: getPointsValue(cropbox.y) - getPointsValue(mediabox.y)
                        }
                    };
    
                    window.onPage({ id, width, height, startToken, endToken, breakAfter, breakBefore, position, boxes });
                });
    
                window.PagedPolyfill.on("size", (size) => {
                    window.onSize(size);
                });
    
                window.PagedPolyfill.on("rendered", (flow) => {
                    let msg = "Rendering " + flow.total + " pages took " + flow.performance + " milliseconds.";
                    window.onRendered(msg, flow.width, flow.height, flow.orientation);
                });
    
                if (window.PagedConfig.before) {
                    await window.PagedConfig.before();
                }
    
                done = await window.PagedPolyfill.preview();
    
                if (window.PagedConfig.after) {
                    await window.PagedConfig.after(done);
                }
            })
    
            await page.waitForSelector(".pagedjs_pages");
        }

        if (request.options.delay) {
            await page.waitForTimeout(request.options.delay);
        }

        if (request.options.initialPageNumber) {
            await page.evaluate((initialPageNumber) => {
                window.pageStart = initialPageNumber;

                const style = document.createElement('style');
                style.type = 'text/css';
                style.innerHTML = '.empty-page { page-break-after: always; visibility: hidden; }';
                document.getElementsByTagName('head')[0].appendChild(style);

                const emptyPages = Array.from({length: window.pageStart}).map(() => {
                    const emptyPage = document.createElement('div');
                    emptyPage.className = "empty-page";
                    emptyPage.textContent = "empty";
                    return emptyPage;
                });
                document.body.prepend(...emptyPages);
            }, request.options.initialPageNumber);
        }

        if (request.options.selector) {
            var element;
            const index = request.options.selectorIndex || 0;
            if(index){
                element = await page.$$(request.options.selector);
                if(!element.length || typeof element[index] === 'undefined'){
                    element = null;
                }else{
                    element = element[index];
                }
            }else{
                element = await page.$(request.options.selector);
            }
            if (element === null) {
                throw {type: 'ElementNotFound'};
            }

            request.options.clip = await element.boundingBox();
        }

        if (request.options.function) {
            let functionOptions = {
                polling: request.options.functionPolling,
                timeout: request.options.functionTimeout || request.options.timeout
            };
            await page.waitForFunction(request.options.function, functionOptions);
        }

        output = await getOutput(page, request);

        if (!request.options.path) {
            console.log(output);
        }

        if (remoteInstance && page) {
            await page.close();
        }

        await remoteInstance ? browser.disconnect() : browser.close();
    } catch (exception) {
        if (browser) {

            if (remoteInstance && page) {
                await page.close();
            }

            await remoteInstance ? browser.disconnect() : browser.close();
        }

        if (exception.type === 'UnsuccessfulResponse') {
            console.error(exception.status)

            process.exit(3);
        }

        console.error(exception);

        if (exception.type === 'ElementNotFound') {
            process.exit(2);
        }

        process.exit(1);
    }
};

if (require.main === module) {
    callChrome();
}

exports.callChrome = callChrome;
