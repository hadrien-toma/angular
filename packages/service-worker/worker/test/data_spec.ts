/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {CacheDatabase} from '../src/db-cache';
import {Driver} from '../src/driver';
import {Manifest} from '../src/manifest';
import {MockRequest} from '../testing/fetch';
import {MockFileSystemBuilder, MockServerStateBuilder, tmpHashTableForFs} from '../testing/mock';
import {SwTestHarness, SwTestHarnessBuilder} from '../testing/scope';

(function() {
  // Skip environments that don't support the minimum APIs needed to run the SW tests.
  if (!SwTestHarness.envIsSupported()) {
    return;
  }

  const dist = new MockFileSystemBuilder()
                   .addFile('/foo.txt', 'this is foo')
                   .addFile('/bar.txt', 'this is bar')
                   .addFile('/api/test', 'version 1')
                   .addFile('/api/a', 'version A')
                   .addFile('/api/b', 'version B')
                   .addFile('/api/c', 'version C')
                   .addFile('/api/d', 'version D')
                   .addFile('/api/e', 'version E')
                   .addFile('/fresh/data', 'this is fresh data')
                   .addFile('/refresh/data', 'this is some data')
                   .build();


  const distUpdate = new MockFileSystemBuilder()
                         .addFile('/foo.txt', 'this is foo v2')
                         .addFile('/bar.txt', 'this is bar')
                         .addFile('/api/test', 'version 2')
                         .addFile('/fresh/data', 'this is fresher data')
                         .addFile('/refresh/data', 'this is refreshed data')
                         .build();

  const manifest: Manifest = {
    configVersion: 1,
    timestamp: 1234567890123,
    index: '/index.html',
    assetGroups: [
      {
        name: 'assets',
        installMode: 'prefetch',
        updateMode: 'prefetch',
        urls: [
          '/foo.txt',
          '/bar.txt',
        ],
        patterns: [],
      },
    ],
    dataGroups: [
      {
        name: 'testPerf',
        maxSize: 3,
        strategy: 'performance',
        patterns: ['^/api/.*$'],
        timeoutMs: 1000,
        maxAge: 5000,
        version: 1,
      },
      {
        name: 'testRefresh',
        maxSize: 3,
        strategy: 'performance',
        patterns: ['^/refresh/.*$'],
        timeoutMs: 1000,
        refreshAheadMs: 1000,
        maxAge: 5000,
        version: 1,
      },
      {
        name: 'testFresh',
        maxSize: 3,
        strategy: 'freshness',
        patterns: ['^/fresh/.*$'],
        timeoutMs: 1000,
        maxAge: 5000,
        version: 1,
      },
    ],
    navigationUrls: [],
    hashTable: tmpHashTableForFs(dist),
  };

  const seqIncreasedManifest: Manifest = {
    ...manifest,
    dataGroups: [
      {
        ...manifest.dataGroups ![0],
        version: 2,
      },
      manifest.dataGroups ![1],
      manifest.dataGroups ![2],
    ],
  };


  const server = new MockServerStateBuilder().withStaticFiles(dist).withManifest(manifest).build();

  const serverUpdate =
      new MockServerStateBuilder().withStaticFiles(distUpdate).withManifest(manifest).build();

  const serverSeqUpdate = new MockServerStateBuilder()
                              .withStaticFiles(distUpdate)
                              .withManifest(seqIncreasedManifest)
                              .build();


  describe('data cache', () => {
    let scope: SwTestHarness;
    let driver: Driver;
    beforeEach(async() => {
      scope = new SwTestHarnessBuilder().withServerState(server).build();
      driver = new Driver(scope, scope, new CacheDatabase(scope, scope));

      // Initialize.
      expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
      await driver.initialized;
      server.clearRequests();
      serverUpdate.clearRequests();
      serverSeqUpdate.clearRequests();
    });
    afterEach(() => {
      server.reset();
      serverUpdate.reset();
      serverSeqUpdate.reset();
    });

    describe('in performance mode', () => {
      it('names the caches correctly', async() => {
        expect(await makeRequest(scope, '/api/test')).toEqual('version 1');
        const keys = await scope.caches.keys();
        expect(keys.every(key => key.startsWith('ngsw:/:'))).toEqual(true);
      });

      it('caches a basic request', async() => {
        expect(await makeRequest(scope, '/api/test')).toEqual('version 1');
        server.assertSawRequestFor('/api/test');
        scope.advance(1000);
        expect(await makeRequest(scope, '/api/test')).toEqual('version 1');
        server.assertNoOtherRequests();
      });

      it('does not cache opaque responses', async() => {
        expect(await makeNoCorsRequest(scope, '/api/test')).toBe('');
        server.assertSawRequestFor('/api/test');

        expect(await makeNoCorsRequest(scope, '/api/test')).toBe('');
        server.assertSawRequestFor('/api/test');
      });

      it('refreshes after awhile', async() => {
        expect(await makeRequest(scope, '/api/test')).toEqual('version 1');
        server.clearRequests();
        scope.advance(10000);
        scope.updateServerState(serverUpdate);
        expect(await makeRequest(scope, '/api/test')).toEqual('version 2');
      });

      it('expires the least recently used entry', async() => {
        expect(await makeRequest(scope, '/api/a')).toEqual('version A');
        expect(await makeRequest(scope, '/api/b')).toEqual('version B');
        expect(await makeRequest(scope, '/api/c')).toEqual('version C');
        expect(await makeRequest(scope, '/api/d')).toEqual('version D');
        expect(await makeRequest(scope, '/api/e')).toEqual('version E');
        server.clearRequests();
        expect(await makeRequest(scope, '/api/c')).toEqual('version C');
        expect(await makeRequest(scope, '/api/d')).toEqual('version D');
        expect(await makeRequest(scope, '/api/e')).toEqual('version E');
        server.assertNoOtherRequests();
        expect(await makeRequest(scope, '/api/a')).toEqual('version A');
        expect(await makeRequest(scope, '/api/b')).toEqual('version B');
        server.assertSawRequestFor('/api/a');
        server.assertSawRequestFor('/api/b');
        server.assertNoOtherRequests();
      });

      it('does not carry over cache with new version', async() => {
        expect(await makeRequest(scope, '/api/test')).toEqual('version 1');
        scope.updateServerState(serverSeqUpdate);
        expect(await driver.checkForUpdate()).toEqual(true);
        await driver.updateClient(await scope.clients.get('default'));
        expect(await makeRequest(scope, '/api/test')).toEqual('version 2');
      });
    });

    describe('in freshness mode', () => {
      it('goes to the server first', async() => {
        expect(await makeRequest(scope, '/fresh/data')).toEqual('this is fresh data');
        server.assertSawRequestFor('/fresh/data');
        server.clearRequests();
        expect(await makeRequest(scope, '/fresh/data')).toEqual('this is fresh data');
        server.assertSawRequestFor('/fresh/data');
        server.assertNoOtherRequests();
        scope.updateServerState(serverUpdate);
        expect(await makeRequest(scope, '/fresh/data')).toEqual('this is fresher data');
        serverUpdate.assertSawRequestFor('/fresh/data');
        serverUpdate.assertNoOtherRequests();
      });

      it('caches opaque responses', async() => {
        expect(await makeNoCorsRequest(scope, '/fresh/data')).toBe('');
        server.assertSawRequestFor('/fresh/data');

        server.online = false;

        expect(await makeRequest(scope, '/fresh/data')).toBe('');
        server.assertNoOtherRequests();
      });

      it('falls back on the cache when server times out', async() => {
        expect(await makeRequest(scope, '/fresh/data')).toEqual('this is fresh data');
        server.assertSawRequestFor('/fresh/data');
        server.clearRequests();
        scope.updateServerState(serverUpdate);
        serverUpdate.pause();
        const [res, done] = makePendingRequest(scope, '/fresh/data');

        await serverUpdate.nextRequest;

        // Since the network request doesn't return within the timeout of 1,000ms,
        // this should return cached data.
        scope.advance(2000);

        expect(await res).toEqual('this is fresh data');

        // Unpausing allows the worker to continue with caching.
        serverUpdate.unpause();
        await done;

        serverUpdate.pause();
        const [res2, done2] = makePendingRequest(scope, '/fresh/data');
        await serverUpdate.nextRequest;
        scope.advance(2000);
        expect(await res2).toEqual('this is fresher data');
      });

      it('refreshes ahead', async() => {
        server.assertNoOtherRequests();
        serverUpdate.assertNoOtherRequests();
        expect(await makeRequest(scope, '/refresh/data')).toEqual('this is some data');
        server.assertSawRequestFor('/refresh/data');
        server.clearRequests();
        expect(await makeRequest(scope, '/refresh/data')).toEqual('this is some data');
        server.assertNoOtherRequests();
        scope.updateServerState(serverUpdate);
        scope.advance(1500);
        expect(await makeRequest(scope, '/refresh/data')).toEqual('this is some data');
        serverUpdate.assertSawRequestFor('/refresh/data');
        expect(await makeRequest(scope, '/refresh/data')).toEqual('this is refreshed data');
        serverUpdate.assertNoOtherRequests();
      });
    });
  });
})();

function makeRequest(scope: SwTestHarness, url: string, clientId?: string): Promise<string|null> {
  const [resTextPromise, done] = makePendingRequest(scope, url, clientId);
  return done.then(() => resTextPromise);
}

function makeNoCorsRequest(
    scope: SwTestHarness, url: string, clientId?: string): Promise<String|null> {
  const req = new MockRequest(url, {mode: 'no-cors'});
  const [resTextPromise, done] = makePendingRequest(scope, req, clientId);
  return done.then(() => resTextPromise);
}

function makePendingRequest(
    scope: SwTestHarness, urlOrReq: string | MockRequest,
    clientId?: string): [Promise<string|null>, Promise<void>] {
  const req = (typeof urlOrReq === 'string') ? new MockRequest(urlOrReq) : urlOrReq;
  const [resPromise, done] = scope.handleFetch(req, clientId || 'default');
  return [
    resPromise.then<string|null>(res => res ? res.text() : null),
    done,
  ];
}
