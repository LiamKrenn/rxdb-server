import assert from 'assert';

import {
    addRxPlugin,
    clone,
    randomCouchString
} from 'rxdb/plugins/core';
import {
    type RxServerChangeValidator,
    type RxServerQueryModifier,
    startRxServer
} from '../../plugins/server';
import {
    replicateServer
} from '../../plugins/replication-server';
import {
    schemaObjects,
    schemas,
    nextPort,
    humansCollection,
    ensureReplicationHasNoErrors,
    isFastMode,
    HumanDocumentType
} from 'rxdb/plugins/test-utils';
import { wait, waitUntil } from 'async-test-util';
import EventSource from 'eventsource';

import config from './config.ts';
import { AuthType, authHandler, headers, urlSubPaths } from './test-helpers.ts';


describe('endpoint-replication.test.ts', () => {
    assert.ok(config);
    describe('basics', () => {
        it('should start end stop the server', async () => {
            const port = await nextPort();
            const col = await humansCollection.create(0);
            const server = await startRxServer({
                database: col.database,
                authHandler,
                port
            });
            await server.addReplicationEndpoint({
                collection: col
            });
            await col.database.destroy();
        });
    });
    describe('replication endoint', () => {
        describe('basics', () => {
            it('should be able to reach the endpoint', async function () {
                const col = await humansCollection.create(1);
                const port = await nextPort();
                const server = await startRxServer({
                    database: col.database,
                    authHandler,
                    port
                });
                const endpoint = await server.addReplicationEndpoint({
                    collection: col
                });
                const url = 'http://localhost:' + port + '/' + endpoint.urlPath + '/pull';
                const response = await fetch(url, {
                    headers
                });
                const data = await response.json();
                assert.ok(data.documents[0]);
                assert.ok(data.checkpoint);
                await col.database.destroy();
            });
        });
        describe('replication', () => {
            it('should replicate all data in both directions', async function () {
                const col = await humansCollection.create(5);
                const port = await nextPort();
                const server = await startRxServer({
                    database: col.database,
                    authHandler,
                    port
                });
                const endpoint = await server.addReplicationEndpoint({
                    collection: col
                });
                const clientCol = await humansCollection.create(5);
                const url = 'http://localhost:' + port + '/' + endpoint.urlPath;
                const replicationState = await replicateServer({
                    collection: clientCol,
                    replicationIdentifier: randomCouchString(10),
                    url,
                    headers,
                    push: {},
                    pull: {},
                    eventSource: EventSource
                });
                ensureReplicationHasNoErrors(replicationState);

                await replicationState.awaitInSync();

                const docsB = await clientCol.find().exec();
                assert.strictEqual(docsB.length, 10);

                const docsA = await col.find().exec();
                assert.strictEqual(docsA.length, 10);

                await col.database.destroy();
                await clientCol.database.destroy();
            });
            it('create read update delete', async () => {
                const serverCol = await humansCollection.create(0);
                const port = await nextPort();
                const server = await startRxServer({
                    database: serverCol.database,
                    authHandler,
                    port
                });
                const endpoint = await server.addReplicationEndpoint({
                    collection: serverCol
                });
                const clientCol = await humansCollection.create(0);
                const url = 'http://localhost:' + port + '/' + endpoint.urlPath;
                const replicationState = await replicateServer({
                    collection: clientCol,
                    replicationIdentifier: randomCouchString(10),
                    url,
                    headers,
                    live: true,
                    push: {},
                    pull: {},
                    eventSource: EventSource
                });
                ensureReplicationHasNoErrors(replicationState);
                await replicationState.awaitInSync();

                // create
                const clientDoc = await clientCol.insert(schemaObjects.humanData(undefined, 1));
                await replicationState.awaitInSync();
                await waitUntil(async () => {
                    const docs = await serverCol.find().exec();
                    return docs.length === 1;
                });

                // update
                await clientDoc.incrementalPatch({ age: 2 });
                await replicationState.awaitInSync();
                await waitUntil(async () => {
                    const serverDoc = await serverCol.findOne().exec(true);
                    console.dir(serverDoc.toJSON());
                    return serverDoc.age === 2;
                });

                // delete
                await clientDoc.getLatest().remove();
                await replicationState.awaitInSync();
                await waitUntil(async () => {
                    const docs = await serverCol.find().exec();
                    return docs.length === 0;
                });

                serverCol.database.destroy();
                clientCol.database.destroy();
            });
            it('should give a 426 error on outdated versions', async () => {
                const newestSchema = clone(schemas.human);
                newestSchema.version = 1;
                const col = await humansCollection.createBySchema(newestSchema, undefined, undefined, { 1: d => d });
                const port = await nextPort();
                const server = await startRxServer({
                    database: col.database,
                    authHandler,
                    port
                });
                await server.addReplicationEndpoint({
                    collection: col
                });

                // check with plain requests
                for (const path of urlSubPaths) {
                    const response = await fetch('http://localhost:' + port + '/replication/human/0/' + path);
                    assert.strictEqual(response.status, 426);
                }

                // check with replication
                const clientCol = await humansCollection.createBySchema(schemas.human);
                const replicationState = await replicateServer({
                    collection: clientCol,
                    replicationIdentifier: randomCouchString(10),
                    url: 'http://localhost:' + port + '/replication/human/0',
                    headers,
                    push: {},
                    pull: {},
                    eventSource: EventSource
                });

                const errors: any[] = [];
                replicationState.error$.subscribe(err => errors.push(err));

                let emittedOutdated = false;
                replicationState.outdatedClient$.subscribe(() => emittedOutdated = true);
                await waitUntil(() => emittedOutdated);

                await waitUntil(() => errors.length > 0);
                const firstError = errors[0];
                assert.strictEqual(firstError.code, 'RC_PULL');

                col.database.destroy();
                clientCol.database.destroy();
            });
            it('must replicate ongoing changes', async () => {
                const col = await humansCollection.create(5);
                const port = await nextPort();
                const server = await startRxServer({
                    database: col.database,
                    authHandler,
                    port
                });
                const endpoint = await server.addReplicationEndpoint({
                    collection: col
                });
                const clientCol = await humansCollection.create(5);
                const url = 'http://localhost:' + port + '/' + endpoint.urlPath;
                console.log(':::::::::::::::::::::::::::::::: 0');
                const replicationState = await replicateServer({
                    collection: clientCol,
                    replicationIdentifier: randomCouchString(10),
                    url,
                    headers,
                    live: true,
                    push: {},
                    pull: {},
                    eventSource: EventSource
                });
                await replicationState.awaitInSync();

                console.log(':::::::::::::::::::::::::::::::: 1');

                // server to client
                await col.insert(schemaObjects.humanData());
                await waitUntil(async () => {
                    const docs = await clientCol.find().exec();
                    return docs.length === 11;
                });

                console.log(':::::::::::::::::::::::::::::::: 2');
                // client to server
                await clientCol.insert(schemaObjects.humanData());
                await waitUntil(async () => {
                    const docs = await col.find().exec();
                    return docs.length === 12;
                });
                console.log(':::::::::::::::::::::::::::::::: 3');

                // do not miss updates when connection is dropped
                server.httpServer.closeAllConnections();
                await col.insert(schemaObjects.humanData());
                await waitUntil(async () => {
                    const docs = await clientCol.find().exec();
                    return docs.length === 13;
                });
                console.log(':::::::::::::::::::::::::::::::: 4');

                col.database.destroy();
                clientCol.database.destroy();
            });
        });
        describe('authentification', () => {
            it('should drop non authenticated clients', async () => {
                const col = await humansCollection.create(1);
                const port = await nextPort();
                const server = await startRxServer({
                    database: col.database,
                    authHandler,
                    port
                });
                const endpoint = await server.addReplicationEndpoint({
                    collection: col
                });
                const url = 'http://localhost:' + port + '/' + endpoint.urlPath;

                // check with plain requests
                for (const path of urlSubPaths) {
                    const response = await fetch(url + '/' + path);
                    assert.equal(response.status, 401);
                    const data = await response.json();
                    console.dir(data);
                }
                console.log(':::::000000 0');

                // check with replication
                const clientCol = await humansCollection.create(1);
                const replicationState = await replicateServer({
                    collection: clientCol,
                    replicationIdentifier: randomCouchString(10),
                    url,
                    headers: {},
                    live: true,
                    push: {},
                    pull: {},
                    eventSource: EventSource,
                    retryTime: 100
                });

                let emittedUnauthorized = false;
                replicationState.unauthorized$.subscribe(() => emittedUnauthorized = true);

                console.log(':::::000000 1');

                await waitUntil(() => emittedUnauthorized === true);

                console.log(':::::000000 2');
                // setting correct headers afterwards should make the replication work again
                replicationState.headers = headers;
                await replicationState.awaitInSync();
                console.log(':::::000000 3');

                await col.insert(schemaObjects.humanData('after-correct-headers'));
                console.log(':::::000000 3.1');
                await waitUntil(async () => {
                    const docs = await clientCol.find().exec();
                    console.log('dcos.lenght:' + docs.length);
                    return docs.length === 3;
                }, 2500, 150);
                console.log(':::::000000 4');

                await replicationState.awaitInSync();
                console.log(':::::000000 5');
                await col.insert(schemaObjects.humanData('after-correct-headers-ongoing'));
                console.log(':::::000000 6');
                await waitUntil(async () => {
                    const docs = await clientCol.find().exec();
                    return docs.length === 4;
                });

                col.database.destroy();
                clientCol.database.destroy();
            });
        });
        describe('queryModifier', () => {
            const queryModifier: RxServerQueryModifier<AuthType, HumanDocumentType> = (authData, query) => {
                query.selector.firstName = { $eq: authData.data.userid };
                return query;
            };
            it('should only return the matching documents to the client', async () => {
                const serverCol = await humansCollection.create(5);
                await serverCol.insert(schemaObjects.humanData('only-matching', 1, headers.userid));
                const port = await nextPort();
                const server = await startRxServer({
                    database: serverCol.database,
                    authHandler,
                    port
                });
                const endpoint = await server.addReplicationEndpoint({
                    collection: serverCol,
                    queryModifier
                });
                const clientCol = await humansCollection.create(0);
                const url = 'http://localhost:' + port + '/' + endpoint.urlPath;
                const replicationState = await replicateServer({
                    collection: clientCol,
                    replicationIdentifier: randomCouchString(10),
                    url,
                    headers,
                    live: true,
                    push: {},
                    pull: {},
                    eventSource: EventSource
                });
                ensureReplicationHasNoErrors(replicationState);
                await replicationState.awaitInSync();

                // only the allowed document should be on the client
                await waitUntil(async () => {
                    const docs = await clientCol.find().exec();
                    return docs.length === 1;
                });

                // also ongoing events should only be replicated if matching
                await serverCol.bulkInsert([
                    schemaObjects.humanData('matching1', 1, headers.userid),
                    schemaObjects.humanData('matching2', 1, headers.userid),
                    schemaObjects.humanData(),
                    schemaObjects.humanData()
                ]);
                await replicationState.awaitInSync();

                await waitUntil(async () => {
                    const docs = await clientCol.find().exec();
                    console.dir(docs.map(d => d.toJSON()));
                    return docs.length === 3;
                });

                serverCol.database.destroy();
                clientCol.database.destroy();
            });
            it('should only accept the matching documents on the server', async () => {
                const serverCol = await humansCollection.create(0);
                const port = await nextPort();
                const server = await startRxServer({
                    database: serverCol.database,
                    authHandler,
                    port
                });
                const endpoint = await server.addReplicationEndpoint({
                    collection: serverCol,
                    queryModifier
                });
                const clientCol = await humansCollection.create(0);
                await clientCol.insert(schemaObjects.humanData('only-matching', 1, headers.userid));
                const url = 'http://localhost:' + port + '/' + endpoint.urlPath;
                const replicationState = await replicateServer({
                    collection: clientCol,
                    replicationIdentifier: randomCouchString(10),
                    url,
                    headers,
                    live: true,
                    push: {},
                    pull: {},
                    eventSource: EventSource
                });
                await replicationState.awaitInSync();

                let forbiddenEmitted = false;
                replicationState.forbidden$.subscribe(() => forbiddenEmitted = true);

                // only the allowed document should be on the server
                await waitUntil(async () => {
                    const docs = await serverCol.find().exec();
                    return docs.length === 1;
                });

                // also ongoing events should only be replicated if matching
                await clientCol.insert(schemaObjects.humanData('matching1', 1, headers.userid));
                await replicationState.awaitInSync();
                await waitUntil(async () => {
                    const docs = await serverCol.find().exec();
                    return docs.length === 2;
                });

                // when at least one document does not match, do no longer push anything
                await clientCol.bulkInsert([
                    schemaObjects.humanData(),
                    schemaObjects.humanData(),
                    schemaObjects.humanData('matching2', 2, headers.userid)
                ]);
                await wait(isFastMode() ? 100 : 200);

                // should not have pushed anything
                const serverDocs = await serverCol.find().exec();
                assert.strictEqual(serverDocs.length, 2);

                await waitUntil(() => forbiddenEmitted === true);

                serverCol.database.destroy();
                clientCol.database.destroy();
            });
        });
        describe('changeValidator', () => {
            const changeValidator: RxServerChangeValidator<AuthType, HumanDocumentType> = (authData, change) => {
                if (change.assumedMasterState && change.assumedMasterState.firstName !== authData.data.userid) {
                    return false;
                }
                if (change.newDocumentState.firstName !== authData.data.userid) {
                    return false;
                }
                return true;
            };
            it('should not accept non-allowed writes', async () => {
                const serverCol = await humansCollection.create(0);
                const port = await nextPort();
                const server = await startRxServer({
                    database: serverCol.database,
                    authHandler,
                    port
                });
                const endpoint = await server.addReplicationEndpoint({
                    collection: serverCol,
                    changeValidator
                });
                const clientCol = await humansCollection.create(0);
                const url = 'http://localhost:' + port + '/' + endpoint.urlPath;
                const replicationState = await replicateServer({
                    collection: clientCol,
                    replicationIdentifier: randomCouchString(10),
                    url,
                    headers,
                    live: true,
                    push: {},
                    pull: {},
                    eventSource: EventSource
                });
                await replicationState.awaitInSync();
                let forbiddenEmitted = false;
                replicationState.forbidden$.subscribe(() => forbiddenEmitted = true);

                // insert document
                const clientDoc = await clientCol.insert(schemaObjects.humanData(undefined, 1, headers.userid));
                await waitUntil(async () => {
                    const docs = await serverCol.find().exec();
                    return docs.length === 1;
                });

                // update document
                await clientDoc.incrementalPatch({ age: 2 });
                await replicationState.awaitInSync();
                await waitUntil(async () => {
                    const serverDoc = await serverCol.findOne().exec(true);
                    return serverDoc.age === 2;
                });

                // make disallowed change
                await clientDoc.getLatest().incrementalPatch({ firstName: 'foobar' });
                await waitUntil(() => forbiddenEmitted === true);
                const serverDocAfter = await serverCol.findOne().exec(true);
                assert.strictEqual(serverDocAfter.firstName, headers.userid);

                serverCol.database.destroy();
                clientCol.database.destroy();
            });
        });
    });
});
