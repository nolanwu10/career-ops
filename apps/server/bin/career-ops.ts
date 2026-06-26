#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ScannerStack } from '../infrastructure/scanner-stack.js';

const app = new App();
const stage = app.node.tryGetContext('stage') || process.env.CAREER_OPS_STAGE || 'dev';
const emailDomain = stringSetting(app, 'emailDomain', 'CAREER_OPS_EMAIL_DOMAIN');
const amplifyRepository = stringSetting(app, 'amplifyRepository', 'CAREER_OPS_AMPLIFY_REPOSITORY');
const amplifyAccessTokenSecretName = stringSetting(app, 'amplifyAccessTokenSecretName', 'CAREER_OPS_AMPLIFY_ACCESS_TOKEN_SECRET_NAME');
const amplifyBranchName = stringSetting(app, 'amplifyBranchName', 'CAREER_OPS_AMPLIFY_BRANCH') || 'main';
const amplifyAppDomain = stringSetting(app, 'amplifyAppDomain', 'CAREER_OPS_AMPLIFY_APP_DOMAIN');
const enableAmplifyPullRequestPreview = booleanSetting(app, 'enableAmplifyPullRequestPreview', 'CAREER_OPS_ENABLE_AMPLIFY_PULL_REQUEST_PREVIEW');

new ScannerStack(app, `CareerOps-${stage === 'dev' ? 'Dev' : stage}-Scanner`, {
  stage,
  emailDomain,
  amplifyRepository,
  amplifyAccessTokenSecretName,
  amplifyBranchName,
  amplifyAppDomain,
  enableAmplifyPullRequestPreview,
  env: {
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
    account: process.env.CDK_DEFAULT_ACCOUNT
  }
});

function stringSetting(app: App, contextKey: string, envKey: string): string | undefined {
  return app.node.tryGetContext(contextKey) || process.env[envKey] || undefined;
}

function booleanSetting(app: App, contextKey: string, envKey: string): boolean {
  const value = app.node.tryGetContext(contextKey) ?? process.env[envKey];
  return value === true || value === 'true' || value === '1';
}
