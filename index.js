const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3")
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner")
const chromium = require("chrome-aws-lambda")
const PNG = require("pngjs").PNG
const { GIFEncoder, quantize, applyPalette } = require("gifenc")

// bucket name from the env variables
const S3_BUCKET = process.env.S3_BUCKET
const S3_REGION = process.env.S3_REGION

//
// CONSTANTS
//
const DEFAULT_VIEWPORT_WIDTH = 800
const DEFAULT_VIEWPORT_HEIGHT = 800
const PAGE_TIMEOUT = 300000
const DELAY_MIN = 0
const DELAY_MAX = 600000 // 10 min

// GIF specific constants
const GIF_DEFAULTS = {
  FRAME_COUNT: 30,
  CAPTURE_INTERVAL: 100, // milliseconds between capturing frames
  PLAYBACK_FPS: 10, // default playback speed in frames per second
  QUALITY: 10,
  MIN_FRAMES: 2,
  MAX_FRAMES: 100,
  MIN_CAPTURE_INTERVAL: 20,
  MAX_CAPTURE_INTERVAL: 15000,
  MIN_FPS: 1,
  MAX_FPS: 50,
}

// response headers - maximizes compatibility
const HEADERS = {
  "Content-Type": "application/json",
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
  "https://fs-emulator.fxhash-dev.xyz/",
  "https://fs-emulator.fxhash.xyz/",
  "https://fs-emulator.fxhash2.xyz/",
  "https://file-api.fxhash-dev.xyz/",
  "https://file-api.fxhash.xyz/",
  "https://onchfs.fxhash-dev2.xyz/",
  "https://onchfs.fxhash2.xyz/",
  "https://onchfs.fxhash.xyz/",
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
  APPROACHING_TIMEOUT: "APPROACHING_TIMEOUT",
  INVALID_GIF_PARAMETERS: "INVALID_GIF_PARAMETERS",
}
// the different capture modes
const CAPTURE_MODES = ["CANVAS", "VIEWPORT"]
// the list of accepted trigger modes
const TRIGGER_MODES = ["DELAY", "FN_TRIGGER"]

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
    return (
      typeof delay !== undefined &&
      !isNaN(delay) &&
      delay >= DELAY_MIN &&
      delay <= DELAY_MAX
    )
  } else if (triggerMode === "FN_TRIGGER") {
    // fn trigger doesn't need any param
    return true
  }
}

function validateGifParams(frameCount, captureInterval, playbackFps) {
  if (
    frameCount < GIF_DEFAULTS.MIN_FRAMES ||
    frameCount > GIF_DEFAULTS.MAX_FRAMES
  ) {
    return false
  }

  if (
    captureInterval < GIF_DEFAULTS.MIN_CAPTURE_INTERVAL ||
    captureInterval > GIF_DEFAULTS.MAX_CAPTURE_INTERVAL
  ) {
    return false
  }

  if (
    playbackFps < GIF_DEFAULTS.MIN_FPS ||
    playbackFps > GIF_DEFAULTS.MAX_FPS
  ) {
    return false
  }

  return true
}

const sleep = time =>
  new Promise(resolve => {
    setTimeout(resolve, time)
  })

/**
 * Depending on the trigger mode, will wait for the trigger to occur and will
 * then resolve. In any case, the trigger is raced by a sleep on the MAX_DELAY
 * (either implicit or actual race)
 */
const waitPreview = (triggerMode, page, delay) =>
  new Promise(async resolve => {
    if (triggerMode === "DELAY") {
      console.log("waiting for delay:", delay)
      await sleep(delay)
      resolve()
    } else if (triggerMode === "FN_TRIGGER") {
      console.log("waiting for function trigger...")
      Promise.race([
        // add event listener and wait for event to fire before returning
        page.evaluate(function () {
          return new Promise(function (resolve, reject) {
            window.addEventListener("fxhash-preview", function () {
              resolve() // resolves when the event fires
            })
          })
        }),
        sleep(DELAY_MAX),
      ]).then(resolve)
    }
  })

const waitPreviewWithFallback = async (context, triggerMode, page, delay) => {
  console.log("configuring fallback...")

  // set up a promise that will reject if the lambda is about to timeout
  const timeoutThresholdMillis = 30_000
  const lambdaTimeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(ERRORS.APPROACHING_TIMEOUT)),
      context.getRemainingTimeInMillis() - timeoutThresholdMillis
    )
  )

  try {
    // wait for the preview or the lambda timeout
    await Promise.race([
      waitPreview(triggerMode, page, delay),
      lambdaTimeoutPromise,
    ])
  } catch (err) {
    // catch the error if it's due to the lambda timeout
    if (err.message === ERRORS.APPROACHING_TIMEOUT) {
      console.log("Fallback triggered due to Lambda timeout")
      return
    }
    // otherwise, rethrow the error
    throw err
  }
}

async function captureFramesToGif(frames, width, height, playbackFps) {
  const gif = GIFEncoder()
  const playbackDelay = Math.round(1000 / playbackFps)
  console.log(
    `Creating GIF with playback delay: ${playbackDelay}ms (${playbackFps} FPS)`
  )

  for (const frame of frames) {
    let pngData
    if (typeof frame === "string") {
      // For base64 data from canvas
      const pureBase64 = frame.replace(/^data:image\/png;base64,/, "")
      const buffer = Buffer.from(pureBase64, "base64")
      pngData = await new Promise((resolve, reject) => {
        new PNG().parse(buffer, (err, data) => {
          if (err) reject(err)
          resolve(data)
        })
      })
    } else {
      // For binary data from viewport
      pngData = await new Promise((resolve, reject) => {
        new PNG().parse(frame, (err, data) => {
          if (err) reject(err)
          resolve(data)
        })
      })
    }

    const pixels = new Uint8Array(pngData.data)
    const palette = quantize(pixels, 256)
    const index = applyPalette(pixels, palette)

    gif.writeFrame(index, width, height, {
      palette,
      delay: playbackDelay, // Use the playback timing here
    })
  }

  gif.finish()
  return Buffer.from(gif.bytes())
}

// process the raw features extracted into attributes
function processRawTokenFeatures(rawFeatures) {
  const features = []
  // first check if features are an object
  if (
    typeof rawFeatures !== "object" ||
    Array.isArray(rawFeatures) ||
    !rawFeatures
  ) {
    throw new Error("Invalid features")
  }
  // go through each property and process it
  for (const name in rawFeatures) {
    // chack if propery is accepted type
    if (
      !(
        typeof rawFeatures[name] === "boolean" ||
        typeof rawFeatures[name] === "string" ||
        typeof rawFeatures[name] === "number"
      )
    ) {
      continue
    }
    // all good, the feature can be added safely
    features.push({
      name,
      value: rawFeatures[name],
    })
  }
  return features
}

const extractFeatures = async page => {
  console.log("extracting features...")

  // find $fxhashFeatures in the window object
  let rawFeatures = null
  try {
    const extractedFeatures = await page.evaluate(() => {
      // v3 syntax
      if (window.$fx?._features) return JSON.stringify(window.$fx._features)
      // deprecated syntax
      return JSON.stringify(window.$fxhashFeatures)
    })
    rawFeatures = (extractedFeatures && JSON.parse(extractedFeatures)) || null
  } catch (e) {
    console.error("Error extracting features:", e)
    throw ERRORS.EXTRACT_FEATURES_FAILED
  }

  // turn raw features into attributes
  try {
    return processRawTokenFeatures(rawFeatures)
  } catch (e) {
    console.error("Error processing features:", e)
  }
}

const performCapture = async (
  mode,
  page,
  canvasSelector,
  gif,
  frameCount,
  captureInterval,
  playbackFps
) => {
  console.log("performing capture...")

  // if viewport mode, use the native puppeteer page.screenshot
  if (mode === "VIEWPORT") {
    // we simply take a capture of the viewport
    return captureViewport(page, gif, frameCount, captureInterval, playbackFps)
  }
  // if the mode is canvas, we need to execute som JS on the client to select
  // the canvas and generate a dataURL to bridge it in here
  else if (mode === "CANVAS") {
    return captureCanvas(
      page,
      canvasSelector,
      gif,
      frameCount,
      captureInterval,
      playbackFps
    )
  }
}

const uploadToS3 = async (context, capture, features, isGif) => {
  const baseKey = `${context.functionName}/${context.awsRequestId}`
  const extension = isGif ? "gif" : "png"
  const contentType = isGif ? "image/gif" : "image/png"

  const client = new S3Client({
    region: S3_REGION,
  })

  await client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `${baseKey}/preview.${extension}`,
      Body: capture,
      ContentType: contentType,
    })
  )
  // upload the features object to a JSON file
  await client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `${baseKey}/features.json`,
      Body: JSON.stringify(features),
      ContentType: "application/json",
    })
  )

  // generate 2 presigned URLs to the capture & feature files
  return {
    capture: await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${baseKey}/preview.${extension}`,
      }),
      { expiresIn: 3600 }
    ),
    features: await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${baseKey}/features.json`,
      }),
      { expiresIn: 3600 }
    ),
  }
}

const validateParams = ({
  url,
  mode,
  resX,
  resY,
  triggerMode = "DELAY",
  delay,
  canvasSelector,
  gif,
  frameCount,
  captureInterval,
  playbackFps,
}) => {
  if (!url || !mode) throw ERRORS.MISSING_PARAMETERS
  if (!isUrlValid(url)) throw ERRORS.UNSUPPORTED_URL
  if (!CAPTURE_MODES.includes(mode)) throw ERRORS.INVALID_PARAMETERS
  if (!isTriggerValid(triggerMode, delay))
    throw ERRORS.INVALID_TRIGGER_PARAMETERS

  if (gif && !validateGifParams(frameCount, captureInterval, playbackFps))
    throw ERRORS.INVALID_GIF_PARAMETERS

  if (mode === "VIEWPORT") {
    if (!resX || !resY) throw ERRORS.MISSING_PARAMETERS
    resX = Math.round(resX)
    resY = Math.round(resY)
    if (
      isNaN(resX) ||
      isNaN(resY) ||
      resX < 256 ||
      resX > 2048 ||
      resY < 256 ||
      resY > 2048
    )
      throw ERRORS.INVALID_PARAMETERS
  } else if (mode === "CANVAS") {
    if (!canvasSelector) throw ERRORS.MISSING_PARAMETERS
  }
  return {
    url,
    mode,
    resX,
    resY,
    triggerMode,
    delay,
    canvasSelector,
    gif,
    frameCount,
    captureInterval,
    playbackFps,
  }
}

async function captureViewport(
  page,
  isGif,
  frameCount,
  captureInterval,
  playbackFps
) {
  if (!isGif) {
    return await page.screenshot()
  }

  const frames = []
  for (let i = 0; i < frameCount; i++) {
    // Capture raw pixels instead of base64
    const frameBuffer = await page.screenshot({
      encoding: "binary",
    })
    frames.push(frameBuffer)
    await sleep(captureInterval)
  }

  const viewport = page.viewport()
  return await captureFramesToGif(
    frames,
    viewport.width,
    viewport.height,
    playbackFps
  )
}

async function captureCanvas(
  page,
  canvasSelector,
  isGif,
  frameCount,
  captureInterval,
  playbackFps
) {
  try {
    if (!isGif) {
      // get the base64 image from the CANVAS targetted
      const base64 = await page.$eval(canvasSelector, el => {
        if (!el || el.tagName !== "CANVAS") return null
        return el.toDataURL()
      })
      if (!base64) throw null
      // remove the base64 mimetype at the beginning of the string
      const pureBase64 = base64.replace(/^data:image\/png;base64,/, "")
      return Buffer.from(pureBase64, "base64")
    }

    const frames = []

    for (let i = 0; i < frameCount; i++) {
      // Get raw pixel data from canvas
      const base64 = await page.$eval(canvasSelector, el => {
        if (!el || el.tagName !== "CANVAS") return null
        return el.toDataURL()
      })
      if (!base64) throw null
      frames.push(base64)
      await sleep(captureInterval)
    }

    const dimensions = await page.$eval(canvasSelector, el => ({
      width: el.width,
      height: el.height,
    }))

    return await captureFramesToGif(
      frames,
      dimensions.width,
      dimensions.height,
      playbackFps
    )
  } catch (e) {
    console.error(e)
    throw ERRORS.CANVAS_CAPTURE_FAILED
  }
}

// main invocation handler
exports.handler = async (event, context) => {
  let browser = null,
    httpResponse = null

  try {
    // if we have an OPTIONS request, only return the headers
    if (event.requestContext.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: HEADERS,
      }
    }

    const { useFallbackCaptureOnTimeout = false, ...body } = JSON.parse(
      event.body
    )
    const {
      url,
      mode,
      resX,
      resY,
      triggerMode,
      delay,
      canvasSelector,
      gif = false,
      frameCount = GIF_DEFAULTS.FRAME_COUNT,
      captureInterval = GIF_DEFAULTS.CAPTURE_INTERVAL,
      playbackFps = GIF_DEFAULTS.PLAYBACK_FPS,
    } = validateParams(body)

    console.log("running capture with params:", {
      url,
      mode,
      resX,
      resY,
      triggerMode,
      delay,
      canvasSelector,
      gif,
      frameCount,
      captureInterval,
      playbackFps,
    })

    console.log("bootstrapping chromium...")

    // bootstrap chromium
    browser = await chromium.puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    })

    console.log("configuring page...")

    // browse to the page
    const viewportSettings = {
      deviceScaleFactor: 1,
      width: mode === "VIEWPORT" ? resX : DEFAULT_VIEWPORT_WIDTH,
      height: mode === "VIEWPORT" ? resY : DEFAULT_VIEWPORT_HEIGHT,
    }
    let page = await browser.newPage()
    await page.setViewport(viewportSettings)

    // try to reach the page
    let response
    try {
      console.log("navigating to: ", url)
      response = await page.goto(url, {
        timeout: PAGE_TIMEOUT,
      })
      console.log(`navigated to URL with response status: ${response.status()}`)
    } catch (err) {
      console.log(err)
      if (err && err.name && err.name === "TimeoutError") {
        throw ERRORS.TIMEOUT
      } else {
        throw err
      }
    }

    // ensures that we get a 200 when requesting the resource - any 4xx/5xx
    // needs to throw to prevent blank capture generation
    if (response.status() !== 200) throw ERRORS.HTTP_ERROR

    const processCapture = async () => {
      const capture = await performCapture(
        mode,
        page,
        canvasSelector,
        gif,
        frameCount,
        captureInterval,
        playbackFps
      )
      const features = (await extractFeatures(page)) || []
      console.log("uploading capture to S3...")
      const upload = await uploadToS3(context, capture, features, gif)
      console.log("successfully uploaded capture to S3")
      return upload
    }

    if (useFallbackCaptureOnTimeout) {
      await waitPreviewWithFallback(context, triggerMode, page, delay)
    } else {
      await waitPreview(triggerMode, page, delay)
    }

    httpResponse = await processCapture()
  } catch (error) {
    console.error(error)
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({
        error:
          typeof error === "string" && ERRORS[error] ? error : ERRORS.UNKNOWN,
      }),
    }
  } finally {
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
