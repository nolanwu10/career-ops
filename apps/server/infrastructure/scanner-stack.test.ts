import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ScannerStack, type ScannerStackProps } from './scanner-stack.js';

function template(stage = 'dev', props: Partial<ScannerStackProps> = {}): Template {
  const app = new App();
  return Template.fromStack(new ScannerStack(app, 'TestStack', { stage, ...props }));
}

test('stack provisions the hosted app data model and secure file storage', () => {
  const value = template();
  value.resourceCountIs('AWS::DynamoDB::Table', 6);
  value.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    SSESpecification: { SSEEnabled: true }
  });
  value.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'CareerOps-Dev-OnboardingStates'
  });
  value.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'CareerOps-Dev-AIBudgets',
    TimeToLiveSpecification: {
      AttributeName: 'expiresAt',
      Enabled: true
    }
  });
  value.hasResourceProperties('AWS::S3::Bucket', {
    BucketName: 'career-ops-dev-user-files',
    PublicAccessBlockConfiguration: Match.objectLike({
      BlockPublicAcls: true,
      BlockPublicPolicy: true
    })
  });
  value.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      Enabled: true
    })
  });
});

test('stack provisions Cognito, REST API routes, and direct streaming output', () => {
  const value = template();
  value.resourceCountIs('AWS::Cognito::UserPool', 1);
  value.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  value.resourceCountIs('AWS::ApiGateway::Authorizer', 1);
  value.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'GET',
    AuthorizationType: 'COGNITO_USER_POOLS'
  });
  value.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'PUT',
    AuthorizationType: 'COGNITO_USER_POOLS'
  });
  value.hasResourceProperties('AWS::Lambda::Url', {
    AuthType: 'NONE',
    InvokeMode: 'RESPONSE_STREAM'
  });
  value.hasOutput('CoverLetterStreamUrl', {});
});

test('stack adds WAF, alarms, and dashboard coverage for the hosted stack', () => {
  const value = template();
  value.resourceCountIs('AWS::WAFv2::WebACL', 1);
  value.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  value.resourceCountIs('AWS::CloudWatch::Alarm', 4);
  value.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  value.hasResourceProperties('AWS::WAFv2::WebACL', {
    Scope: 'REGIONAL',
    Rules: Match.arrayWith([
      Match.objectLike({ Name: 'RateLimitPerIp' }),
      Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
      Match.objectLike({ Name: 'AWSManagedRulesSQLiRuleSet' })
    ])
  });
});

test('production tables enable retention safeguards', () => {
  const value = template('prod');
  value.hasResourceProperties('AWS::DynamoDB::Table', {
    DeletionProtectionEnabled: true,
    PointInTimeRecoverySpecification: {
      PointInTimeRecoveryEnabled: true
    }
  });
});

test('stack optionally provisions Amplify hosting resources for the web app', () => {
  const value = template('prod', {
    amplifyRepository: 'https://github.com/example/career-ops',
    amplifyAccessTokenSecretName: 'career-ops/prod/github-token',
    amplifyBranchName: 'main',
    amplifyAppDomain: 'app.example.com'
  });

  value.resourceCountIs('AWS::Amplify::App', 1);
  value.resourceCountIs('AWS::Amplify::Branch', 1);
  value.resourceCountIs('AWS::Amplify::Domain', 1);
  value.hasResourceProperties('AWS::Amplify::App', {
    Platform: 'WEB_COMPUTE',
    Repository: 'https://github.com/example/career-ops',
    EnvironmentVariables: Match.arrayWith([
      Match.objectLike({ Name: 'AMPLIFY_MONOREPO_APP_ROOT', Value: 'apps/web' })
    ])
  });
  value.hasResourceProperties('AWS::Amplify::Branch', {
    BranchName: 'main',
    EnableAutoBuild: true,
    EnvironmentVariables: Match.arrayWith([
      Match.objectLike({ Name: 'AMPLIFY_MONOREPO_APP_ROOT', Value: 'apps/web' }),
      Match.objectLike({ Name: 'APP_URL', Value: 'https://app.example.com' }),
      Match.objectLike({ Name: 'CLOUD_API_URL' }),
      Match.objectLike({ Name: 'COGNITO_CLIENT_ID' }),
      Match.objectLike({ Name: 'COGNITO_DOMAIN' }),
      Match.objectLike({ Name: 'COVER_LETTER_STREAM_URL' })
    ])
  });
  value.hasResourceProperties('AWS::Amplify::Domain', {
    DomainName: 'example.com',
    SubDomainSettings: Match.arrayWith([
      Match.objectLike({ BranchName: 'main', Prefix: 'app' })
    ])
  });
});
