import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
  aws_amplify as amplify,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cloudwatch as cloudwatch,
  aws_apigateway as apigw,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_ses as ses,
  aws_wafv2 as wafv2,
  custom_resources as customResources
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { developmentProfiles } from '../src/catalog.js';

export interface ScannerStackProps extends StackProps {
  stage?: string;
  emailDomain?: string;
  amplifyRepository?: string;
  amplifyAccessTokenSecretName?: string;
  amplifyBranchName?: string;
  amplifyAppDomain?: string;
  enableAmplifyPullRequestPreview?: boolean;
}

const directory = path.dirname(fileURLToPath(import.meta.url));

export class ScannerStack extends Stack {
  readonly profilesTable: dynamodb.Table;
  readonly onboardingStatesTable: dynamodb.Table;
  readonly applicationsTable: dynamodb.Table;
  readonly resumeVariantsTable: dynamodb.Table;
  readonly knowledgeTable: dynamodb.Table;
  readonly aiBudgetsTable: dynamodb.Table;
  readonly userFilesBucket: s3.Bucket;
  readonly filesDistribution: cloudfront.Distribution;
  readonly apiWorker: lambdaNodejs.NodejsFunction;
  readonly resumeParserWorker: lambdaNodejs.NodejsFunction;
  readonly coverLetterWorker: lambdaNodejs.NodejsFunction;
  readonly restApi: apigw.RestApi;
  readonly userPool: cognito.UserPool;
  readonly amplifyApp?: amplify.CfnApp;
  readonly amplifyBranch?: amplify.CfnBranch;

  constructor(scope: Construct, id: string, props: ScannerStackProps = {}) {
    super(scope, id, props);
    const stage = props.stage ?? 'dev';
    const production = stage === 'prod';
    const removalPolicy = production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const amplifyBranchName = props.amplifyBranchName ?? 'main';
    const configuredAmplifyDomain = normalizeDomain(props.amplifyAppDomain);
    const localAppOrigins = ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000'];
    const localCallbackUrls = ['http://localhost:3000/auth/callback', 'http://localhost:3001/auth/callback', 'http://127.0.0.1:43119/auth/callback'];
    const localLogoutUrls = ['http://localhost:3000/', 'http://localhost:3001/', 'http://127.0.0.1:43119/'];

    if (props.amplifyAccessTokenSecretName && !props.amplifyRepository) {
      throw new Error('amplifyRepository is required when amplifyAccessTokenSecretName is set.');
    }

    if (props.amplifyRepository) {
      this.amplifyApp = new amplify.CfnApp(this, 'AmplifyApp', {
        name: `career-ops-${stage}`,
        description: 'Hosted Career Ops web app',
        repository: props.amplifyRepository,
        accessToken: props.amplifyAccessTokenSecretName
          ? SecretValue.secretsManager(props.amplifyAccessTokenSecretName).toString()
          : undefined,
        platform: 'WEB_COMPUTE',
        enableBranchAutoDeletion: true,
        buildSpec: amplifyBuildSpec(),
        environmentVariables: [
          {
            name: 'AMPLIFY_MONOREPO_APP_ROOT',
            value: 'apps/web'
          }
        ]
      });
    }

    const hostedAppOrigin = configuredAmplifyDomain
      ? `https://${configuredAmplifyDomain}`
      : this.amplifyApp
        ? `https://${amplifyBranchName}.${this.amplifyApp.attrDefaultDomain}`
        : null;
    const allowedAppOrigins = production
      ? [hostedAppOrigin ?? 'https://app.yourdomain.com']
      : hostedAppOrigin
        ? [...localAppOrigins, hostedAppOrigin]
        : localAppOrigins;
    const callbackUrls = production
      ? [`${hostedAppOrigin ?? 'https://app.yourdomain.com'}/auth/callback`]
      : hostedAppOrigin
        ? [...localCallbackUrls, `${hostedAppOrigin}/auth/callback`]
        : localCallbackUrls;
    const logoutUrls = production
      ? [`${hostedAppOrigin ?? 'https://app.yourdomain.com'}/`]
      : hostedAppOrigin
        ? [...localLogoutUrls, `${hostedAppOrigin}/`]
        : localLogoutUrls;

    // ─── DynamoDB tables ──────────────────────────────────────────────────────

    this.profilesTable = new dynamodb.Table(this, 'ProfilesTable', {
      tableName: `CareerOps-${capitalize(stage)}-UserProfiles`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: production ? { pointInTimeRecoveryEnabled: true } : undefined,
      deletionProtection: production,
      removalPolicy
    });

    this.onboardingStatesTable = new dynamodb.Table(this, 'OnboardingStatesTable', {
      tableName: `CareerOps-${capitalize(stage)}-OnboardingStates`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: production ? { pointInTimeRecoveryEnabled: true } : undefined,
      deletionProtection: production,
      removalPolicy
    });

    this.applicationsTable = new dynamodb.Table(this, 'ApplicationsTable', {
      tableName: `CareerOps-${capitalize(stage)}-Applications`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'applicationId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: production ? { pointInTimeRecoveryEnabled: true } : undefined,
      deletionProtection: production,
      removalPolicy
    });

    this.resumeVariantsTable = new dynamodb.Table(this, 'ResumeVariantsTable', {
      tableName: `CareerOps-${capitalize(stage)}-ResumeVariants`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'variantId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: production ? { pointInTimeRecoveryEnabled: true } : undefined,
      deletionProtection: production,
      removalPolicy
    });

    this.knowledgeTable = new dynamodb.Table(this, 'KnowledgeTable', {
      tableName: `CareerOps-${capitalize(stage)}-Knowledge`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'factId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: production ? { pointInTimeRecoveryEnabled: true } : undefined,
      deletionProtection: production,
      removalPolicy
    });

    // PK: userId, SK: operationDate (e.g. "cover_letter#2024-01-01") for per-user per-operation daily budget
    this.aiBudgetsTable = new dynamodb.Table(this, 'AIBudgetsTable', {
      tableName: `CareerOps-${capitalize(stage)}-AIBudgets`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'operationDate', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: production ? { pointInTimeRecoveryEnabled: true } : undefined,
      deletionProtection: production,
      removalPolicy
    });

    // ─── S3 user files bucket ─────────────────────────────────────────────────

    this.userFilesBucket = new s3.Bucket(this, 'UserFilesBucket', {
      bucketName: `career-ops-${stage}-user-files`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !production,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedOrigins: allowedAppOrigins,
          allowedHeaders: ['*'],
          maxAge: 3600
        }
      ],
      lifecycleRules: [
        {
          id: 'abort-incomplete-multipart',
          abortIncompleteMultipartUploadAfter: Duration.days(1),
          enabled: true
        }
      ]
    });

    // ─── CloudFront distribution in front of S3 ───────────────────────────────

    const oai = new cloudfront.OriginAccessIdentity(this, 'FilesOAI', {
      comment: `career-ops-${stage}-files`
    });
    this.userFilesBucket.grantRead(oai);

    this.filesDistribution = new cloudfront.Distribution(this, 'FilesDistribution', {
      comment: `career-ops-${stage}-files`,
      defaultBehavior: {
        origin: new origins.S3Origin(this.userFilesBucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021
    });

    // ─── Secrets Manager ──────────────────────────────────────────────────────

    const openAiSecret = new secretsmanager.Secret(this, 'OpenAiApiKey', {
      secretName: `career-ops/${stage}/openai-api-key`,
      description: 'OpenAI API key — populate manually via Secrets Manager console after deploy',
      removalPolicy
    });

    // ─── SES email identity ───────────────────────────────────────────────────
    // Created before Cognito so the UserPool can express a dependency on the verified domain.

    let sesEmailIdentity: ses.EmailIdentity | undefined;
    if (props.emailDomain) {
      sesEmailIdentity = new ses.EmailIdentity(this, 'EmailIdentity', {
        identity: ses.Identity.domain(props.emailDomain)
      });
    }

    // ─── Cognito ──────────────────────────────────────────────────────────────

    // Use SES for transactional email when a domain is provided (avoids Cognito's
    // @cognito.com sender which lands in spam and is capped at 50 emails/day).
    const cognitoEmail = props.emailDomain
      ? cognito.UserPoolEmail.withSES({
          fromEmail: `noreply@${props.emailDomain}`,
          fromName: 'Career Ops',
          sesRegion: this.region,
          sesVerifiedDomain: props.emailDomain
        })
      : cognito.UserPoolEmail.withCognito();

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `career-ops-${stage}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      email: cognitoEmail,
      // Optional MFA via TOTP — required MFA kills sign-up conversion
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      // Email-only recovery — no SMS dependency
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: false
      },
      removalPolicy
    });
    // CloudFormation must not create the UserPool until SES has the domain identity,
    // otherwise Cognito will reject the SES configuration at deploy time.
    if (sesEmailIdentity) {
      this.userPool.node.addDependency(sesEmailIdentity);
    }
    const userPoolClient = this.userPool.addClient('ApplicationClient', {
      userPoolClientName: `career-ops-${stage}-app`,
      generateSecret: false,
      authFlows: { userSrp: true },
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls,
        logoutUrls
      }
    });
    const domain = this.userPool.addDomain('HostedDomain', {
      cognitoDomain: { domainPrefix: `career-ops-${stage}-${this.account}` }
    });

    // ─── Lambda: API handler ──────────────────────────────────────────────────

    this.apiWorker = new lambdaNodejs.NodejsFunction(this, 'ApiWorker', {
      functionName: `career-ops-${stage}-api`,
      entry: path.resolve(directory, '..', 'src', 'api-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      memorySize: 512,
      logRetention: production ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
      environment: {
        PROFILES_TABLE: this.profilesTable.tableName,
        ONBOARDING_STATES_TABLE: this.onboardingStatesTable.tableName,
        APPLICATIONS_TABLE: this.applicationsTable.tableName,
        RESUME_VARIANTS_TABLE: this.resumeVariantsTable.tableName,
        KNOWLEDGE_TABLE: this.knowledgeTable.tableName,
        AI_BUDGETS_TABLE: this.aiBudgetsTable.tableName,
        USER_FILES_BUCKET: this.userFilesBucket.bucketName,
        COGNITO_USER_POOL_ID: this.userPool.userPoolId
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: ['@aws-sdk/*']
      }
    });
    this.profilesTable.grantReadWriteData(this.apiWorker);
    this.onboardingStatesTable.grantReadWriteData(this.apiWorker);
    this.applicationsTable.grantReadWriteData(this.apiWorker);
    this.resumeVariantsTable.grantReadWriteData(this.apiWorker);
    this.knowledgeTable.grantReadWriteData(this.apiWorker);
    this.aiBudgetsTable.grantReadWriteData(this.apiWorker);
    this.userFilesBucket.grantReadWrite(this.apiWorker);
    // Allow account deletion to remove the user from Cognito
    this.apiWorker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminDeleteUser'],
      resources: [this.userPool.userPoolArn]
    }));

    // ─── Lambda: Resume parser ────────────────────────────────────────────────

    this.resumeParserWorker = new lambdaNodejs.NodejsFunction(this, 'ResumeParser', {
      functionName: `career-ops-${stage}-resume-parser`,
      entry: path.resolve(directory, '..', 'src', 'resume-parser.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      memorySize: 1024,
      logRetention: production ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
      environment: {
        PROFILES_TABLE: this.profilesTable.tableName,
        AI_BUDGETS_TABLE: this.aiBudgetsTable.tableName,
        USER_FILES_BUCKET: this.userFilesBucket.bucketName,
        OPENAI_SECRET_ARN: openAiSecret.secretArn
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['pdf-parse', 'mammoth']
      }
    });
    this.profilesTable.grantReadWriteData(this.resumeParserWorker);
    this.aiBudgetsTable.grantReadWriteData(this.resumeParserWorker);
    this.userFilesBucket.grantRead(this.resumeParserWorker);
    openAiSecret.grantRead(this.resumeParserWorker);

    // ─── Lambda: Cover letter generator ──────────────────────────────────────

    this.coverLetterWorker = new lambdaNodejs.NodejsFunction(this, 'CoverLetterGenerator', {
      functionName: `career-ops-${stage}-cover-letter`,
      entry: path.resolve(directory, '..', 'src', 'cover-letter-generator.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(60),
      memorySize: 512,
      logRetention: production ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
      environment: {
        PROFILES_TABLE: this.profilesTable.tableName,
        APPLICATIONS_TABLE: this.applicationsTable.tableName,
        AI_BUDGETS_TABLE: this.aiBudgetsTable.tableName,
        OPENAI_SECRET_ARN: openAiSecret.secretArn,
        COGNITO_USER_POOL_ID: this.userPool.userPoolId,
        COGNITO_APP_CLIENT_ID: userPoolClient.userPoolClientId
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: ['@aws-sdk/*']
      }
    });
    this.profilesTable.grantReadData(this.coverLetterWorker);
    this.applicationsTable.grantReadData(this.coverLetterWorker);
    this.aiBudgetsTable.grantReadWriteData(this.coverLetterWorker);
    openAiSecret.grantRead(this.coverLetterWorker);

    // Function URL with response streaming — Lambda verifies Cognito JWT from Authorization header
    const coverLetterUrl = this.coverLetterWorker.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: allowedAppOrigins,
        allowedHeaders: ['authorization', 'content-type'],
        allowedMethods: [lambda.HttpMethod.POST]
      }
    });

    // ─── HTTP API ─────────────────────────────────────────────────────────────

    this.restApi = new apigw.RestApi(this, 'RestApi', {
      restApiName: `career-ops-${stage}`,
      defaultCorsPreflightOptions: {
        allowOrigins: allowedAppOrigins,
        allowHeaders: ['authorization', 'content-type', 'idempotency-key'],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
      },
      deployOptions: {
        stageName: stage,
        metricsEnabled: true,
        tracingEnabled: true
      }
    });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [this.userPool]
    });
    const apiInt = new apigw.LambdaIntegration(this.apiWorker);
    const parserInt = new apigw.LambdaIntegration(this.resumeParserWorker);
    const coverLetterInt = new apigw.LambdaIntegration(this.coverLetterWorker);

    const routes: Array<readonly [string, string, apigw.LambdaIntegration]> = [
      // Profile
      ['GET',    '/v1/profile',                      apiInt],
      ['PUT',    '/v1/profile',                      apiInt],
      // Onboarding
      ['GET',    '/v1/onboarding/state',             apiInt],
      ['PUT',    '/v1/onboarding/state',             apiInt],
      ['GET',    '/v1/onboarding/resume/upload-url', apiInt],
      ['POST',   '/v1/onboarding/resume',            parserInt],
      ['POST',   '/v1/onboarding/profile',           apiInt],
      ['POST',   '/v1/onboarding/cover-letter/preview', coverLetterInt],
      // Applications
      ['GET',    '/v1/applications',                 apiInt],
      ['POST',   '/v1/applications',                 apiInt],
      ['POST',   '/v1/applications/{id}/cover-letter', coverLetterInt],
      ['PATCH',  '/v1/applications/{id}',            apiInt],
      ['DELETE', '/v1/applications/{id}',            apiInt],
      // Resume variants
      ['GET',    '/v1/resume-variants',              apiInt],
      ['POST',   '/v1/resume-variants',              apiInt],
      ['DELETE', '/v1/resume-variants/{id}',         apiInt],
      // Discovery
      ['POST',   '/v1/discovery/import',             apiInt],
      // Knowledge center
      ['GET',    '/v1/knowledge',                    apiInt],
      ['POST',   '/v1/knowledge',                    apiInt],
      ['DELETE', '/v1/knowledge/{id}',               apiInt],
      // Account
      ['DELETE', '/v1/account',                      apiInt],
      // File URLs (pre-signed S3)
      ['GET',    '/v1/files/upload-url',             apiInt],
      ['GET',    '/v1/files/download-url',           apiInt]
    ];

    for (const [method, path_, integration] of routes) {
      this.addRestRoute(method, path_, integration, authorizer);
    }

    // ─── WAF ──────────────────────────────────────────────────────────────────

    const webAcl = new wafv2.CfnWebACL(this, 'ApiWebAcl', {
      name: `career-ops-${stage}-api`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `CareerOps${capitalize(stage)}WAF`,
        sampledRequestsEnabled: true
      },
      rules: [
        {
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `CareerOps${capitalize(stage)}RateLimit`,
            sampledRequestsEnabled: true
          },
          statement: {
            rateBasedStatement: {
              limit: 500,
              aggregateKeyType: 'IP'
            }
          }
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `CareerOps${capitalize(stage)}CommonRules`,
            sampledRequestsEnabled: true
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet'
            }
          }
        },
        {
          name: 'AWSManagedRulesSQLiRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `CareerOps${capitalize(stage)}SQLi`,
            sampledRequestsEnabled: true
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesSQLiRuleSet'
            }
          }
        }
      ]
    });

    new wafv2.CfnWebACLAssociation(this, 'ApiWebAclAssociation', {
      resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${this.restApi.restApiId}/stages/${this.restApi.deploymentStage.stageName}`,
      webAclArn: webAcl.attrArn
    });

    // ─── Dev profile seeding ──────────────────────────────────────────────────

    for (const profile of developmentProfiles) {
      const seed = new customResources.AwsCustomResource(this, `SeedProfile-${profile.userId}`, {
        onCreate: {
          service: 'DynamoDB',
          action: 'putItem',
          parameters: {
            TableName: this.profilesTable.tableName,
            Item: toAttributeMap(profile),
            ConditionExpression: 'attribute_not_exists(userId)'
          },
          physicalResourceId: customResources.PhysicalResourceId.of(`profile-${profile.userId}`)
        },
        onUpdate: {
          service: 'DynamoDB',
          action: 'putItem',
          parameters: {
            TableName: this.profilesTable.tableName,
            Item: toAttributeMap(profile)
          },
          physicalResourceId: customResources.PhysicalResourceId.of(`profile-${profile.userId}`)
        },
        policy: customResources.AwsCustomResourcePolicy.fromSdkCalls({
          resources: [this.profilesTable.tableArn]
        }),
        installLatestAwsSdk: false
      });
      seed.node.addDependency(this.profilesTable);
    }

    if (this.amplifyApp) {
      const appUrl = hostedAppOrigin ?? `https://${amplifyBranchName}.${this.amplifyApp.attrDefaultDomain}`;
      this.amplifyBranch = new amplify.CfnBranch(this, 'AmplifyBranch', {
        appId: this.amplifyApp.attrAppId,
        branchName: amplifyBranchName,
        stage: production ? 'PRODUCTION' : 'DEVELOPMENT',
        framework: 'Express',
        enableAutoBuild: true,
        enablePullRequestPreview: Boolean(props.enableAmplifyPullRequestPreview),
        environmentVariables: [
          { name: 'AMPLIFY_MONOREPO_APP_ROOT', value: 'apps/web' },
          { name: 'APP_URL', value: appUrl },
          { name: 'CLOUD_API_URL', value: this.restApi.url.replace(/\/$/, '') },
          { name: 'COGNITO_CLIENT_ID', value: userPoolClient.userPoolClientId },
          { name: 'COGNITO_DOMAIN', value: domain.baseUrl() },
          { name: 'COVER_LETTER_STREAM_URL', value: coverLetterUrl.url },
          { name: 'NODE_ENV', value: production ? 'production' : 'development' }
        ]
      });
      this.amplifyBranch.addDependency(this.amplifyApp);

      if (configuredAmplifyDomain) {
        const subDomain = splitCustomDomain(configuredAmplifyDomain);
        const amplifyDomain = new amplify.CfnDomain(this, 'AmplifyDomain', {
          appId: this.amplifyApp.attrAppId,
          domainName: subDomain.domainName,
          enableAutoSubDomain: Boolean(props.enableAmplifyPullRequestPreview),
          autoSubDomainCreationPatterns: props.enableAmplifyPullRequestPreview ? ['*'] : undefined,
          subDomainSettings: [
            {
              branchName: amplifyBranchName,
              prefix: subDomain.prefix
            }
          ]
        });
        amplifyDomain.addDependency(this.amplifyBranch);

        new CfnOutput(this, 'AmplifyCustomDomainCertificateRecord', {
          value: amplifyDomain.attrCertificateRecord
        });
      }
    }

    this.addObservability(stage);

    // ─── Outputs ──────────────────────────────────────────────────────────────

    new CfnOutput(this, 'ApiUrl',               { value: this.restApi.url });
    new CfnOutput(this, 'CognitoUserPoolId',    { value: this.userPool.userPoolId });
    new CfnOutput(this, 'CognitoClientId',      { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'CognitoHostedUiUrl',   { value: domain.baseUrl() });
    new CfnOutput(this, 'UserFilesBucketName',  { value: this.userFilesBucket.bucketName });
    new CfnOutput(this, 'FilesDistributionUrl', { value: `https://${this.filesDistribution.distributionDomainName}` });
    new CfnOutput(this, 'OpenAiSecretArn',      { value: openAiSecret.secretArn });
    new CfnOutput(this, 'CoverLetterStreamUrl', { value: coverLetterUrl.url });
    if (this.amplifyApp) {
      new CfnOutput(this, 'AmplifyAppId', { value: this.amplifyApp.attrAppId });
      new CfnOutput(this, 'AmplifyDefaultDomain', { value: this.amplifyApp.attrDefaultDomain });
    }
  }

  private addObservability(stage: string): void {
    const apiErrorAlarm = new cloudwatch.Alarm(this, 'ApiErrorsAlarm', {
      alarmName: `CareerOps-${capitalize(stage)}-Api-Errors`,
      metric: this.apiWorker.metricErrors({ period: Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1
    });
    const resumeParserErrorAlarm = new cloudwatch.Alarm(this, 'ResumeParserErrorsAlarm', {
      alarmName: `CareerOps-${capitalize(stage)}-ResumeParser-Errors`,
      metric: this.resumeParserWorker.metricErrors({ period: Duration.minutes(5) }),
      threshold: 3,
      evaluationPeriods: 1
    });
    const coverLetterErrorAlarm = new cloudwatch.Alarm(this, 'CoverLetterErrorsAlarm', {
      alarmName: `CareerOps-${capitalize(stage)}-CoverLetter-Errors`,
      metric: this.coverLetterWorker.metricErrors({ period: Duration.minutes(5) }),
      threshold: 3,
      evaluationPeriods: 1
    });
    const apiThrottleAlarm = new cloudwatch.Alarm(this, 'ApiThrottlesAlarm', {
      alarmName: `CareerOps-${capitalize(stage)}-Api-Throttles`,
      metric: this.apiWorker.metricThrottles({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1
    });

    const dashboard = new cloudwatch.Dashboard(this, 'CareerOpsDashboard', {
      dashboardName: `CareerOps-${capitalize(stage)}`
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda invocations',
        left: [
          this.apiWorker.metricInvocations({ period: Duration.minutes(5) }),
          this.resumeParserWorker.metricInvocations({ period: Duration.minutes(5) }),
          this.coverLetterWorker.metricInvocations({ period: Duration.minutes(5) })
        ]
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda errors',
        left: [
          this.apiWorker.metricErrors({ period: Duration.minutes(5) }),
          this.resumeParserWorker.metricErrors({ period: Duration.minutes(5) }),
          this.coverLetterWorker.metricErrors({ period: Duration.minutes(5) })
        ]
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda duration p99',
        left: [
          this.apiWorker.metricDuration({ period: Duration.minutes(5), statistic: 'p99' }),
          this.resumeParserWorker.metricDuration({ period: Duration.minutes(5), statistic: 'p99' }),
          this.coverLetterWorker.metricDuration({ period: Duration.minutes(5), statistic: 'p99' })
        ]
      }),
      new cloudwatch.AlarmWidget({ title: 'API errors', alarm: apiErrorAlarm }),
      new cloudwatch.AlarmWidget({ title: 'API throttles', alarm: apiThrottleAlarm }),
      new cloudwatch.AlarmWidget({ title: 'Resume parser errors', alarm: resumeParserErrorAlarm }),
      new cloudwatch.AlarmWidget({ title: 'Cover letter errors', alarm: coverLetterErrorAlarm })
    );
  }

  private addRestRoute(
    method: string,
    path_: string,
    integration: apigw.LambdaIntegration,
    authorizer: apigw.CognitoUserPoolsAuthorizer
  ): void {
    let resource = this.restApi.root;
    for (const segment of path_.split('/').filter(Boolean)) {
      resource = resource.getResource(segment) ?? resource.addResource(segment);
    }
    resource.addMethod(method, integration, {
      authorizationType: apigw.AuthorizationType.COGNITO,
      authorizer
    });
  }
}

function amplifyBuildSpec(): string {
  return [
    'version: 1',
    'frontend:',
    '  phases:',
    '    preBuild:',
    '      commands:',
    '        - npm ci',
    '    build:',
    '      commands:',
    '        - npm run build --workspace=apps/web',
    '  artifacts:',
    '    baseDirectory: apps/web/.amplify-hosting',
    '    files:',
    "      - '**/*'"
  ].join('\n');
}

function normalizeDomain(value?: string): string | undefined {
  if (!value) return undefined;
  return value.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function splitCustomDomain(value: string): { domainName: string; prefix: string } {
  const parts = value.split('.').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Invalid Amplify custom domain: ${value}`);
  }
  if (parts.length === 2) {
    return { domainName: value, prefix: '' };
  }
  return {
    domainName: parts.slice(-2).join('.'),
    prefix: parts.slice(0, -2).join('.')
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function toAttributeMap(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toAttribute(item)]));
}

function toAttribute(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(toAttribute) };
  if (value && typeof value === 'object') return { M: toAttributeMap(value as Record<string, unknown>) };
  return { NULL: true };
}
