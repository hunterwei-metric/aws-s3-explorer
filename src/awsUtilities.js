import { watch, computed } from 'vue';
import { DateTime } from 'luxon';
import DEBUG from './logger';
import store from './store';
import jwtManager from './jwtManager';

const sha256 = str => crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));

const generateNonce = async () => {
  const hash = await sha256(crypto.getRandomValues(new Uint32Array(4)).toString());
  // https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest
  const hashArray = Array.from(new Uint8Array(hash));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

const base64URLEncode = string => btoa(String.fromCharCode.apply(null, new Uint8Array(string))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function login(forceLogin) {
  const searchParams = new URL(window.location).searchParams;
  store.initialized = true;
  if (store.tokens && DateTime.fromSeconds(jwtManager.decode(store.tokens.access_token).exp) > DateTime.utc()) {
    store.autoLoginIn = true;
    DEBUG.log('Found login token skipping login');
    await convertCredentialsToAWSCredentials();
    store.showSettings = false;
    return;
  }
  store.tokens = null;

  const code = searchParams.get('code');
  if (code !== null) {
    const newUrl = new URL(window.location);
    newUrl.searchParams.delete('nonce');
    newUrl.searchParams.delete('expires_in');
    newUrl.searchParams.delete('access_token');
    newUrl.searchParams.delete('id_token');
    newUrl.searchParams.delete('state');
    newUrl.searchParams.delete('code');
    newUrl.searchParams.delete('iss');
    window.history.replaceState({}, undefined, newUrl.toString());

    const codeVerifier = localStorage.getItem('codeVerifier');
    if (codeVerifier === null) {
      throw new Error('Unexpected code');
    }

    const codeExchangeBody = Object.entries({
      grant_type: 'authorization_code',
      client_id: store.applicationClientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: `${window.location.origin}${window.location.pathname}`
    }).map(([k, v]) => `${k}=${v}`).join('&');

    const res = await fetch(`${store.applicationLoginUrl}/oauth2/token`, {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      body: codeExchangeBody
    });
    if (!res.ok) {
      throw new Error(await res.json());
    }
    const tokens = await res.json();
    store.tokens = tokens;
    await convertCredentialsToAWSCredentials();
    store.showSettings = false;
    store.autoLoginIn = true;
    return;
  }

  DEBUG.log('Validating login parameters');
  if (!await setConfigurationFromCustomDomain()) {
    if (!store.awsAccountId || !store.applicationLoginUrl || !store.applicationClientId || !store.identityPoolId) {
      DEBUG.log('Missing required parameter for login', store.awsAccountId, store.applicationLoginUrl, store.applicationClientId, store.identityPoolId);
      store.showSettings = true;
      return;
    }
  }

  try {
    // eslint-disable-next-line no-new
    new URL(store.applicationLoginUrl);
  } catch (error) {
    DEBUG.log('Invalid application login url:', store.applicationLoginUrl);
    return;
  }

  if (!forceLogin && !store.autoLoginIn) {
    return;
  }
  // otherwise redirect login
  store.autoLoginIn = false;
  const nonce = await generateNonce();
  const codeVerifier = await generateNonce();
  localStorage.setItem('codeVerifier', codeVerifier);
  const codeChallenge = base64URLEncode(await sha256(codeVerifier));
  // redirect to login
  const redirectUri = `${window.location.origin}${window.location.pathname}`;
  store.loggedOut = false;
  window.location = `${store.applicationLoginUrl}/oauth2/authorize?response_type=code&client_id=${store.applicationClientId}&state=${nonce}&code_challenge_method=S256&code_challenge=${codeChallenge}&redirect_uri=${redirectUri}`;
  const waiter = new Promise(resolve => setTimeout(resolve, 2000));
  await convertCredentialsToAWSCredentials();
  await waiter;
}

const awsAccountId = computed(() => store.awsAccountId);
watch(awsAccountId, newAwsAccountId => {
  setConfiguration(newAwsAccountId);
});

export async function fetchSharedSettings() {
  if (window.location.hostname === 'localhost' || window.location.hostname === 'console.rhosys.ch') {
    return;
  }
  try {
    const data = await fetch(new URL(`/shared?hostname=${window.location.hostname}`, 'https://config.files.admsapp.com').toString());
    const configuration = await data.json();
    store.sharedSettings = configuration;
    // If currentBucket was not cached, use the sharedSettings bucket
    if (!store.currentBucket) {
      store.currentBucket = store.sharedSettings.bucket[0];
    }
    DEBUG.log('Updating shared configuration from custom domain.');
  } catch (error) {
    DEBUG.log('Failed to fetch shared configuration for custom domain: ', error);
  }
}

async function setConfigurationFromCustomDomain() {
  if (window.location.hostname !== 'localhost' && window.location.hostname !== 'console.rhosys.ch') {
    try {
      const data = await fetch(new URL(`/?hostname=${window.location.hostname}`, 'https://config.files.admsapp.com').toString());
      const configuration = await data.json();
      DEBUG.log('Setting configuration from custom domain.');
      store.applicationClientId = configuration.applicationClientId;
      store.identityPoolId = configuration.identityPoolId;
      store.cognitoPoolId = configuration.cognitoPoolId;
      store.region = store.identityPoolId.split(':')[0];
      store.applicationLoginUrl = configuration.applicationLoginUrl?.match(/^https:/)
        ? configuration.applicationLoginUrl : `https://${configuration.applicationLoginUrl}.auth.${store.region}.amazoncognito.com`;
      store.autoLoginIn = true;
      return true;
    } catch (error) {
      DEBUG.log('Failed setting configuration for custom domain: ', error);
      return false;
    }
  }
  return false;
}
export async function setConfiguration(newAwsAccountId) {
  DEBUG.log(`AccountID changed, updating configuration: ${newAwsAccountId}`);
  if (!newAwsAccountId) {
    store.applicationClientId = null;
    store.applicationLoginUrl = null;
    store.userRoleId = null;
    return;
  }

  if (await setConfigurationFromCustomDomain()) {
    return;
  }

  let configuration;
  if (newAwsAccountId) {
    if (!configuration) {
      const weightedRegions = ['eu-west-1', 'us-east-1'];
      const configurationList = await Promise.all(weightedRegions.map(async region => {
        try {
          const data = await fetch(`https://s3.${region}.amazonaws.com/s3-explorer.${newAwsAccountId}${region ? '.' : ''}${region || ''}/configuration.json`);
          return await data.json();
        } catch (error) {
          return null;
        }
      }));
      configuration = configurationList.find(c => c);
    }

    if (!configuration) {
      const regions = ['eu-north-1', 'ap-south-1', 'eu-west-3', 'eu-west-2', 'ap-northeast-3', 'ap-northeast-2', 'ap-northeast-1', 'sa-east-1', 'ca-central-1', 'ap-southeast-1',
        'ap-southeast-2', 'eu-central-1', 'us-east-2', 'us-west-1', 'us-west-2'];
      const configurationList = await Promise.all(regions.map(async region => {
        try {
          const data = await fetch(`https://s3.${region}.amazonaws.com/s3-explorer.${newAwsAccountId}${region ? '.' : ''}${region || ''}/configuration.json`);
          return await data.json();
        } catch (error) {
          return null;
        }
      }));
      configuration = configurationList.find(c => c);
    }

    if (!configuration) {
      try {
        const data = await fetch(`https://s3.eu-west-1.amazonaws.com/s3-explorer.${newAwsAccountId}/configuration.json`);
        configuration = await data.json();
      } catch (error) {
        DEBUG.log('Failed to load configuration:', error);
        return;
      }
    }
  }

  if (configuration) {
    DEBUG.log('Configuration for account fetched:', configuration);
    store.applicationClientId = configuration.applicationClientId;
    store.identityPoolId = configuration.identityPoolId;
    store.cognitoPoolId = configuration.cognitoPoolId;
    store.region = store.identityPoolId.split(':')[0];
    store.applicationLoginUrl = configuration.applicationLoginUrl?.match(/^https:/)
      ? configuration.applicationLoginUrl : `https://${configuration.applicationLoginUrl}.auth.${store.region}.amazoncognito.com`;
  }
}

function convertCredentialsToAWSCredentials() {
  if (!store.identityPoolId) {
    return;
  }

  if (!store.tokens) {
    return;
  }

  try {
    const cognitoUserPoolId = jwtManager.decode(store.tokens.id_token).iss.split('/').slice(-1)[0];
    AWS.config.region = store.region;
    AWS.config.credentials = new AWS.CognitoIdentityCredentials({
      IdentityPoolId: store.identityPoolId,
      Logins: { [`cognito-idp.${AWS.config.region}.amazonaws.com/${cognitoUserPoolId}`]: store.tokens.id_token }
    });

    DEBUG.log('Checking credentials');
    AWS.config.credentials.get(async credentialsError => {
      if (credentialsError) {
        DEBUG.log('Failed to get credentials, following requests will not work due to the error:', credentialsError);
        return;
      }

      try {
        const stsResult = await new AWS.STS({ region: store.region }).getCallerIdentity().promise();
        DEBUG.log('AWS Credentials Set', stsResult);
        store.userRoleId = stsResult.Arn.split('/')[1];
        store.autoLoginIn = true;
      } catch (error) {
        DEBUG.log('Failed to get credentials, following requests will not work due to the error:', error);
        store.awsAccountId = null;
        store.applicationClientId = null;
      }
    });
  } catch (error) {
    DEBUG.log('Failed to set credentials, following requests will not work due to the error:', error);
  }
}
