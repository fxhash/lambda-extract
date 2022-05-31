AWS Lambda capture utility
========

This module takes a capture & extract features on most fxhash projects.


# Lambda config

## Environment variables

* `S3_BUCKET`: the name of the bucket
* `S3_REGION`: the region the bucket is in

## Layers

* the `aws-chrome-lambda` layer corresponding to the region, [available here](https://github.com/shelfio/chrome-aws-lambda-layer#available-regions)

## Config

* env: node **14** (16 doesn't work with the layers at the given URL, it needs to be recompiled)
* memory: 4096 MB
* timeout: 600 sec (10 min)