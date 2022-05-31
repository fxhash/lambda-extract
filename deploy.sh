#!/bin/bash

# run zip to compress archive, excluding useless files
#zip -r ../image-tracing.zip . -x "*yarn.lock*" -x "*.git*" -x "*.gitignore*" 

#&& aws lambda update-function-code --function-name holotov-dev-image-tracing --profile baptiste --zip-file fileb://../image-tracing.zip && rm ../image-tracing.zip


#! /bin/sh -
PROGNAME=$0

usage() {
  cat << EOF >&2
Usage: $PROGNAME [-i] [-l <lambda_name>] [-p <profile_name>]
  -l <lambda_name> : the name of the lambda function to deploy to
	    -p <profile> : the name of the local profile authenticated to use AWS CLI
                -i : install the node_modules before pushing
EOF
  exit 1
}

lambda=NULL
profile=NULL   # baptiste
install=0
while getopts l:p:i o; do
  case $o in
    (l) lambda=$OPTARG;;
    (p) profile=$OPTARG;;
    (i) install=$((verbose_level + 1));;
    (*) usage
  esac
done
shift "$((OPTIND - 1))"

# echo lambda=$lambda
# echo profile=$profile
# echo install=$install

# check if required params are set
if [[ "$lambda" = "NULL" ]] || [[ "$profile" = "NULL" ]]
then
	usage
fi

# run npm install modules if required
if [[ $install -eq 1 ]]
then
	npm install
fi

# zip to compress, excluding useless files
zip -r deploy.zip . -x "*yarn.lock*" -x "*.git*" -x "*.gitignore*" -x "*deploy.sh*" -x "*package-lock.json*"

# deploy to AWS lambda using AWS CLI, and profile 
echo "------"
echo "Deploying to AWS Lambda"
echo "------"
echo "aws lambda update-function-code --function-name $lambda --profile $profile --zip-file fileb://./deploy.zip"
aws lambda update-function-code --function-name $lambda --profile $profile --zip-file fileb://./deploy.zip
rm ./deploy.zip

exit 1