// comment s3 calls in index.js and use:
// const fs = require("fs").promises
// await fs.writeFile(`test-capture.${extension}`, capture)
// await fs.writeFile("test-features.json", JSON.stringify(features, null, 2))

const handler = require("./index").handler

// Mock event object
const event = {
  requestContext: {
    httpMethod: "POST",
  },
  body: JSON.stringify({
    url: "https://file-api.fxhash-dev.xyz/fs/resolve/8b5fcb8462e97084416dec1a4905a2b1a52dba60dcb30509fbf52efb611927f2/?fxhash=0x1f6abc2dca63cc114d7caef45f38c27c73ffeeeb18e4a62e616aad5783ab4162&fxchain=BASE&fxiteration=1&fxminter=0x3cfb27bb6083b3985d3f9b3029a135d5978114ff&fxchain=BASE",
    mode: "CANVAS", // or "VIEWPORT"
    canvasSelector: "canvas", // if using CANVAS mode
    resX: 800, // if using VIEWPORT mode
    resY: 800, // if using VIEWPORT mode
    delay: 3000,
    triggerMode: "DELAY",
    gif: true,
    frameCount: 30,
    frameDelay: 100,
  }),
}

// Mock context object
const context = {
  functionName: "test-capture",
  awsRequestId: "test-123",
  getRemainingTimeInMillis: () => 300000,
}

// Mock environment variables
process.env.S3_BUCKET = "test-bucket"
process.env.S3_REGION = "us-east-1"

async function runTest() {
  try {
    const result = await handler(event, context)
    console.log("Result:", result)
  } catch (error) {
    console.error("Error:", error)
  }
}

runTest()
