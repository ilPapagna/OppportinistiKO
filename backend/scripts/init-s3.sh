#!/bin/sh
set -eu
awslocal s3api head-bucket --bucket radice-private 2>/dev/null || awslocal s3api create-bucket --bucket radice-private --region eu-west-1 --create-bucket-configuration LocationConstraint=eu-west-1
awslocal s3api put-public-access-block --bucket radice-private --public-access-block-configuration 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
