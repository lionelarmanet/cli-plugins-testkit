/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as path from 'path';
import * as os from 'os';
import * as shell from 'shelljs';
import { debug } from 'debug';

import { fs } from '@salesforce/core';
import { env } from '@salesforce/kit';

// this seems to be a known eslint error for enums
// eslint-disable-next-line no-shadow
enum AuthStrategy {
  JWT = 'JWT',
  AUTH_URL = 'AUTH_URL',
  REUSE = 'REUSE',
  NONE = 'NONE',
}

const DEFAULT_INSTANCE_URL = 'https://login.salesforce.com';

/**
 * Function examines the env var TESTKIT_JWT_KEY to determine if it needs to be
 * reformatted so when saved to a file the RSA key file contents are formatted
 * properly.
 *
 * Throws an error if function is called and the env var is undefined
 *
 * returns a string that complies with RSA private key file format
 */
const formatJwtKey = (): string => {
  if (env.getString('TESTKIT_JWT_KEY')) {
    let keyLines = env.getString('TESTKIT_JWT_KEY', '').split('\n');
    if (keyLines.length <= 1) {
      const footer = '-----END RSA PRIVATE KEY-----';
      const header = '-----BEGIN RSA PRIVATE KEY-----';
      // strip out header and footer
      const newKeyContents = env.getString('TESTKIT_JWT_KEY', '').replace(header, '').replace(footer, '');
      // check to see if newlines were replaced with spaces
      keyLines = newKeyContents.trim().split(/\s/);
      if (keyLines.length <= 1) {
        // still one big string, split into 64 byte chucks
        keyLines = [header, ...(newKeyContents.match(/.{1,64}/g) as string[]), footer];
      } else {
        keyLines = [header, ...keyLines, footer];
      }
    }
    return keyLines.join('\n');
  } else {
    throw new Error('env var TESTKIT_JWT_KEY is undefined');
  }
};

/**
 * Inspects the environment (via AuthStrategy) and authenticates to a devhub via JWT or AuthUrl
 * Sets the hub as default for use in tests
 *
 * @param homeDir the testSession directory where credential files will be written
 *
 * reads environment variables that are set by the user OR via transferExistingAuthToEnv
 *   for jwt: TESTKIT_HUB_USERNAME, TESTKIT_JWT_CLIENT_ID, TESTKIT_JWT_KEY
 *     optional but recommended: TESTKIT_HUB_INSTANCE
 *   required for AuthUrl:
 */
export const testkitHubAuth = (homeDir: string): void => {
  const logger = debug('testkit:authFromStubbedHome');
  if (getAuthStrategy() === AuthStrategy.JWT) {
    logger('trying jwt auth');
    const jwtKey = path.join(homeDir, 'jwtKey');
    fs.writeFileSync(jwtKey, formatJwtKey());

    shell.exec(
      `sfdx auth:jwt:grant -d -u ${env.getString('TESTKIT_HUB_USERNAME', '')} -i ${env.getString(
        'TESTKIT_JWT_CLIENT_ID',
        ''
      )} -f ${jwtKey} -r ${env.getString('TESTKIT_HUB_INSTANCE', DEFAULT_INSTANCE_URL)}`,
      { silent: true, fatal: true }
    );
    return;
  }
  if (getAuthStrategy() === AuthStrategy.AUTH_URL) {
    logger('trying to authenticate with AuthUrl');

    const tmpUrl = path.join(homeDir, 'tmpUrl');
    fs.writeFileSync(tmpUrl, env.getString('TESTKIT_AUTH_URL', ''));

    const shellOutput = shell.exec(`sfdx auth:sfdxurl:store -d -f ${tmpUrl}`, { silent: true, fatal: true });
    logger(shellOutput);

    return;
  }
  logger('no hub configured');
};

const getAuthStrategy = (): AuthStrategy => {
  if (
    env.getString('TESTKIT_JWT_CLIENT_ID') &&
    env.getString('TESTKIT_HUB_USERNAME') &&
    env.getString('TESTKIT_JWT_KEY')
  ) {
    return AuthStrategy.JWT;
  }
  if (env.getString('TESTKIT_AUTH_URL')) {
    return AuthStrategy.AUTH_URL;
  }
  // none of the above are included, so we want to reuse an already authenticated hub
  if (env.getString('TESTKIT_HUB_USERNAME')) {
    return AuthStrategy.REUSE;
  }
  return AuthStrategy.NONE;
};

/**
 * For scenarios where a hub has already been authenticated in the environment and the username is provided,
 * set the environment variables from the existing hub's information.
 *
 * reads environment variables
 *   TESTKIT_HUB_USERNAME : the username (not alias) of a devHub
 *
 * write environment variables
 *  TESTKIT_AUTH_URL (if using refreshToken)
 *  TESTKIT_JWT_KEY,TESTKIT_JWT_CLIENT_ID,TESTKIT_HUB_INSTANCE (if using jwt)
 *
 */
export const transferExistingAuthToEnv = (): void => {
  // nothing to do if the variables are already provided
  if (getAuthStrategy() !== AuthStrategy.REUSE) return;

  const logger = debug('testkit:AuthReuse');
  logger(`reading ${env.getString('TESTKIT_HUB_USERNAME', '')}.json`);
  const authFileName = `${env.getString('TESTKIT_HUB_USERNAME', '')}.json`;
  const hubAuthFileSource = path.join(env.getString('HOME') || os.homedir(), '.sfdx', authFileName);
  const authFileContents = (fs.readJsonSync(hubAuthFileSource) as unknown) as AuthFile;
  if (authFileContents.privateKey) {
    logger('copying variables to env from AuthFile for JWT');
    // this is jwt.  set the appropriate env vars
    env.setString('TESTKIT_JWT_KEY', fs.readFileSync(authFileContents.privateKey, 'utf-8'));
    env.setString('TESTKIT_JWT_CLIENT_ID', authFileContents.clientId);
    env.setString('TESTKIT_HUB_INSTANCE', authFileContents.instanceUrl);

    return;
  }
  if (authFileContents.refreshToken) {
    // this is an org from web:auth or auth:url.  Generate the authUrl and set in the env
    logger('copying variables to env from org:display for AuthUrl');
    const displayContents = JSON.parse(
      shell.exec(`sfdx force:org:display -u ${env.getString('TESTKIT_HUB_USERNAME', '')} --verbose --json`, {
        silent: true,
        fatal: true,
      }) as string
    ) as OrgDisplayResult;
    logger(`found ${displayContents.result.sfdxAuthUrl}`);
    env.setString('TESTKIT_AUTH_URL', displayContents.result.sfdxAuthUrl);
    return;
  }
  throw new Error(
    `Unable to reuse existing hub ${env.getString('TESTKIT_HUB_USERNAME', '')}.  Check file ${env.getString(
      'TESTKIT_HUB_USERNAME',
      ''
    )}.json`
  );
};

interface AuthFile {
  username: string;
  instanceUrl: string;
  clientId?: string;
  privateKey?: string;
  refreshToken?: string;
}

interface OrgDisplayResult {
  result: {
    sfdxAuthUrl?: string;
  };
}