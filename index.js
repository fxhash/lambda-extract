const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3")
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner")
const chromium = require('chrome-aws-lambda')

// bucket name from the env variables
const S3_BUCKET = process.env.S3_BUCKET
const S3_REGION = process.env.S3_REGION

// 
// CONSTANTS
//
const DELAY_MIN = 0
const DELAY_MAX = 600000 // 10 min
// response headers - maximizes compatibility
const HEADERS = {
  "Content-Type": 'application/json',
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
  "Access-Control-Allow-Credentials": true,
}
// the list of URLs supported by the lambda - it's not open bar
const SUPPORTED_URLS = [
  "https://ipfs.io/ipfs/",
  "https://gateway.fxhash.xyz/ipfs/",
  "https://gateway.fxhash2.xyz/ipfs/",
  "https://gateway.fxhash-dev.xyz/ipfs/",
  "https://gateway.fxhash-dev2.xyz/ipfs/",
]
// the list of errors the lambda can return
const ERRORS = {
  UNKNOWN: "UNKNOWN",
  HTTP_ERROR: "HTTP_ERROR",
  MISSING_PARAMETERS: "MISSING_PARAMETERS",
  INVALID_TRIGGER_PARAMETERS: "INVALID_TRIGGER_PARAMETERS",
  INVALID_PARAMETERS: "INVALID_PARAMETERS",
  UNSUPPORTED_URL: "UNSUPPORTED_URL",
  CANVAS_CAPTURE_FAILED: "CANVAS_CAPTURE_FAILED",
  TIMEOUT: "TIMEOUT",
  EXTRACT_FEATURES_FAILED: "EXTRACT_FEATURES_FAILED",
}
// the different capture modes
const CAPTURE_MODES = [
  "CANVAS",
  "VIEWPORT",
]
// the list of accepted trigger modes
const TRIGGER_MODES = [
  "DELAY",
  "FN_TRIGGER"
]


//
// UTILITY FUNCTIONS
//

// is an URL valid ? (ie: is it accepted by the module ?)
function isUrlValid(url) {
  for (const supported of SUPPORTED_URLS) {
    if (url.startsWith(supported)) {
      return true
    }
  }
  return false
}

// is a trigger valid ? looks at the trigger mode and trigger settings
function isTriggerValid(triggerMode, delay) {
  if (!TRIGGER_MODES.includes(triggerMode)) {
    return false
  }
  if (triggerMode === "DELAY") {
    // delay must be defined if trigger mode is delay
    return typeof delay !== undefined && !isNaN(delay) && delay >= DELAY_MIN && delay <= DELAY_MAX
  }
  else if (triggerMode === "FN_TRIGGER") {
    // fn trigger doesn't need any param
    return true
  }
}

const sleep = (time) => new Promise(resolve => {
  setTimeout(resolve, time)
})

/**
 * Depending on the trigger mode, will wait for the trigger to occur and will
 * then resolve. In any case, the trigger is raced by a sleep on the MAX_DELAY
 * (either implicit or actual race)
 */
const waitPreview = (triggerMode, page, delay) => new Promise(async (resolve) => {
  let resolved = false
  if (triggerMode === "DELAY") {
    await sleep(delay)
    resolve()
  }
  else if (triggerMode === "FN_TRIGGER") {
    Promise.race([
      // add event listener and wait for event to fire before returning
      page.evaluate(function () {
        return new Promise(function (resolve, reject) {
          window.addEventListener("fxhash-preview", function () {
            resolve() // resolves when the event fires
          })
        })
      }),
      sleep(DELAY_MAX)
    ]).then(resolve)
  }
})

// process the raw features extracted into attributes
function processRawTokenFeatures(rawFeatures) {
  const features = []
  // first check if features are an object
  if (typeof rawFeatures !== "object" || Array.isArray(rawFeatures) || !rawFeatures) {
    throw null
  }
  // go through each property and process it
  for (const name in rawFeatures) {
    // chack if propery is accepted type
    if (!(typeof rawFeatures[name] === "boolean" || typeof rawFeatures[name] === "string" || typeof rawFeatures[name] === "number")) {
      continue
    }
    // all good, the feature can be added safely
    features.push({
      name,
      value: rawFeatures[name]
    })
  }
  return features
}

// main invocation handler
exports.handler = async (event, context) => {
  let browser = null,
    capture = null,
    features = [],
    httpResponse = null

  try {
    // if we have an OPTIONS request, only return the headers
    if (event.requestContext.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: HEADERS
      }
    }

    // get the request parameters in the body, as JSON
    const body = JSON.parse(event.body)
    // get the url to capture
    let { url, resX, resY, delay, mode, triggerMode, canvasSelector, features } = body


    //
    // VALIDATE INVOCATION BODY PARAMETERS
    //

    // default parameter for triggerMode
    if (typeof triggerMode === "undefined") {
      triggerMode = "DELAY"
    }

    // check if general parameters are correct
    if (!url || !mode) {
      throw ERRORS.MISSING_PARAMETERS
    }
    if (!isUrlValid(url)) {
      throw ERRORS.UNSUPPORTED_URL
    }
    if (!CAPTURE_MODES.includes(mode)) {
      throw ERRORS.INVALID_PARAMETERS
    }

    // check if trigger paremeters are correct
    if (!isTriggerValid(triggerMode, delay)) {
      throw ERRORS.INVALID_TRIGGER_PARAMETERS
    }

    // check parameters correct based on mode
    if (mode === "VIEWPORT") {
      if (!resX || !resY) {
        throw ERRORS.MISSING_PARAMETERS
      }
      resX = Math.round(resX)
      resY = Math.round(resY)
      if (isNaN(resX) || isNaN(resY) || resX < 256 || resX > 2048 || resY < 256 || resY > 2048) {
        throw ERRORS.MISSING_PARAMETERS
      }
    }
    else if (mode === "CANVAS") {
      if (!canvasSelector) {
        throw ERRORS.MISSING_PARAMETERS
      }
    }

    // todo: add the smiley font Noto

    // bootstrap chromium
    browser = await chromium.puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    })

    // browse to the page
    const viewportSettings = {
      deviceScaleFactor: 1,
    }
    if (mode === "VIEWPORT") {
      viewportSettings.width = resX
      viewportSettings.height = resY
    }
    else {
      viewportSettings.width = 800
      viewportSettings.height = 800
    }
    let page = await browser.newPage()
    await page.setViewport(viewportSettings)

    // try to reach the page
    let response
    try {
      response = await page.goto(url, {
        timeout: 300000
      })
    }
    catch (err) {
      if (err && err.name && err.name === "TimeoutError") {
        throw ERRORS.TIMEOUT
      }
      else {
        throw null
      }
    }

    // ensures that we get a 200 when requesting the resource - any 4xx/5xx 
    // needs to throw to prevent blank capture generation
    if (response.status() !== 200) {
      throw ERRORS.HTTP_ERROR
    }

    //
    // CAPTURE
    //

    // if viewport mode, use the native puppeteer page.screenshot
    if (mode === "VIEWPORT") {
      await waitPreview(triggerMode, page, delay)
      // we simply take a capture of the viewport
      capture = await page.screenshot()
    }
    // if the mode is canvas, we need to execute som JS on the client to select
    // the canvas and generate a dataURL to bridge it in here
    else if (mode === "CANVAS") {
      try {
        await waitPreview(triggerMode, page, delay)
        // get the base64 image from the CANVAS targetted
        const base64 = await page.$eval(canvasSelector, (el) => {
          if (!el || el.tagName !== "CANVAS") return null
          return el.toDataURL()
        })
        if (!base64) throw null
        // remove the base64 mimetype at the beginning of the string
        const pureBase64 = base64.replace(/^data:image\/png;base64,/, "")
        capture = Buffer.from(pureBase64, "base64")
      }
      catch (err) {
        throw ERRORS.CANVAS_CAPTURE_FAILED
      }
    }

    // 
    // EXTRACT FEATURES
    //
    // find $fxhashFeatures in the window object
    let rawFeatures = null
    try {
      const extractedFeatures = await page.evaluate(
        () => {
          // v3 syntax
          if (window.$fx?._features) return JSON.stringify(window.$fx._features)
          // deprecated syntax
          return JSON.stringify(window.$fxhashFeatures)
        }
      )
      rawFeatures = (extractedFeatures && JSON.parse(extractedFeatures)) || null
    }
    catch {
      throw ERRORS.EXTRACT_FEATURES_FAILED
    }

    // turn raw features into attributed
    try {
      features = processRawTokenFeatures(rawFeatures)
    }
    catch { }

    // if features are still undefined, we assume that there are none
    features = features || []

    // call for the close of the browser, but don't wait for it
    browser.close()
    browser = null


    //
    // UPLOAD TO S3 BUCKET
    //

    // the base key, root folder (the fn name is used)
    const baseKey = `${context.functionName}/${context.awsRequestId}`

    // create the S3 client
    const client = new S3Client({
      region: S3_REGION,
    })

    // upload the preview PNG
    await client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `${baseKey}/preview.png`,
      Body: capture,
      ContentType: "image/png",
    }))

    // upload the features object to a JSON file
    await client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `${baseKey}/features.json`,
      Body: JSON.stringify(features),
      ContentType: "application/json",
    }))

    // generate 2 presigned URLs to the capture & feature files
    httpResponse = {
      capture: await getSignedUrl(client, new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${baseKey}/preview.png`
      }), { expiresIn: 3600 }),
      features: await getSignedUrl(client, new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${baseKey}/features.json`
      }), { expiresIn: 3600 })
    }
  }
  catch (error) {
    // throw error
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({
        error: typeof error === "string" && ERRORS[error]
          ? error
          : ERRORS.UNKNOWN
      })
    }
  }
  finally {
    if (browser !== null) {
      browser.close()
    }
  }

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify(httpResponse),
  }
}
