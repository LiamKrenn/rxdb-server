import {
    FilledMangoQuery,
    RxCollection,
    RxReplicationHandler,
    RxReplicationWriteToMasterRow,
    RxStorageDefaultCheckpoint,
    StringKeys,
    prepareQuery,
    getQueryMatcher,
    normalizeMangoQuery,
    getChangedDocumentsSinceQuery
} from 'rxdb/plugins/core';
import { getReplicationHandlerByCollection } from 'rxdb/plugins/replication-websocket';
import type { RxServer } from './rx-server.ts';
import type {
    RxServerAuthData,
    RxServerChangeValidator,
    RxServerEndpoint,
    RxServerQueryModifier
} from './types.ts';
import { filter, map, mergeMap } from 'rxjs';
import {
    ensureNotFalsy,
    getFromMapOrThrow,
    lastOfArray
} from 'rxdb/plugins/utils';

import type {
    Request,
    Response,
    NextFunction
} from 'express';
import expressCors from 'cors';

export type RxReplicationEndpointMessageType = {
    id: string;
    method: StringKeys<RxReplicationHandler<any, any>> | 'auth';
    params: any[];
};


export class RxServerReplicationEndpoint<AuthType, RxDocType> implements RxServerEndpoint {
    readonly type = 'replication';
    readonly urlPath: string;
    constructor(
        public readonly server: RxServer<AuthType>,
        public readonly collection: RxCollection<RxDocType>,
        public readonly queryModifier: RxServerQueryModifier<AuthType, RxDocType>,
        public readonly changeValidator: RxServerChangeValidator<AuthType, RxDocType>,
        public readonly cors?: string
    ) {
        let useCors = cors;
        if (!useCors) {
            useCors = this.server.cors;
        }
        if (useCors) {
            this.server.expressApp.options('/' + [this.type, collection.name].join('/') + '/*', expressCors({
                origin: useCors,
                // some legacy browsers (IE11, various SmartTVs) choke on 204
                optionsSuccessStatus: 200
            }));
        }


        /**
         * "block" the previous version urls and send a 426 on them so that
         * the clients know they must update.
         */
        let v = 0;
        while (v < collection.schema.version) {
            const version = v;
            ['pull', 'push', 'pullStream'].forEach(route => {
                this.server.expressApp.all('/' + [this.type, collection.name, version].join('/') + '/' + route, (req, res) => {
                    console.log('S: autdated version ' + version);
                    closeConnection(res, 426, 'Outdated version ' + version + ' (newest is ' + collection.schema.version + ')');
                });
            });
            v++;
        }

        this.urlPath = [this.type, collection.name, collection.schema.version].join('/');

        console.log('SERVER URL PATH: ' + this.urlPath);

        const replicationHandler = getReplicationHandlerByCollection(this.server.database, collection.name);

        const authDataByRequest = new WeakMap<Request, RxServerAuthData<AuthType>>();


        async function auth(req: Request, res: Response, next: NextFunction) {
            console.log('-- AUTH 1 ' + req.path);
            try {
                const authData = await server.authHandler(req.headers);
                authDataByRequest.set(req, authData);
                console.log('-- AUTH 2');
                next();
            } catch (err) {
                console.log('-- AUTH ERR');
                closeConnection(res, 401, 'Unauthorized');
                return;
            }
            console.log('-- AUTH 3');

        }
        this.server.expressApp.all('/' + this.urlPath + '/*', auth, function (req, res, next) {
            console.log('-- ALL 1');

            next();
        });

        this.server.expressApp.get('/' + this.urlPath + '/pull', async (req, res) => {
            console.log('-- PULL 1');
            const authData = getFromMapOrThrow(authDataByRequest, req);
            const id = req.query.id ? req.query.id as string : '';
            const lwt = req.query.lwt ? parseInt(req.query.lwt as any, 10) : 0;
            const limit = req.query.limit ? parseInt(req.query.limit as any, 10) : 1;
            const plainQuery = getChangedDocumentsSinceQuery<RxDocType, RxStorageDefaultCheckpoint>(
                this.collection.storageInstance,
                limit,
                { id, lwt }
            );
            const useQueryChanges: FilledMangoQuery<RxDocType> = await this.queryModifier(
                ensureNotFalsy(authData),
                plainQuery
            );
            const prepared = prepareQuery<RxDocType>(
                this.collection.schema.jsonSchema,
                useQueryChanges
            );
            const result = await this.collection.storageInstance.query(prepared);
            const documents = result.documents;
            const newCheckpoint = documents.length === 0 ? { id, lwt } : {
                id: ensureNotFalsy(lastOfArray(documents))[this.collection.schema.primaryPath],
                updatedAt: ensureNotFalsy(lastOfArray(documents))._meta.lwt
            };
            res.setHeader('Content-Type', 'application/json');
            res.json({
                documents,
                checkpoint: newCheckpoint
            });
        });
        this.server.expressApp.post('/' + this.urlPath + '/push', async (req, res) => {
            const authData = getFromMapOrThrow(authDataByRequest, req);
            const docDataMatcherWrite = await getDocAllowedMatcher(this, ensureNotFalsy(authData));
            const rows: RxReplicationWriteToMasterRow<RxDocType>[] = req.body;

            console.log('/push body:');
            console.dir(req.body);
            for (const row of rows) {
                // TODO remove this check
                if (row.assumedMasterState && (row.assumedMasterState as any)._meta) {
                    throw new Error('body document contains meta!');
                }
            }

            // ensure all writes are allowed
            const nonAllowedRow = rows.find(row => {
                if (
                    !docDataMatcherWrite(row.newDocumentState as any) ||
                    (row.assumedMasterState && !docDataMatcherWrite(row.assumedMasterState as any))
                ) {
                    return true;
                }
            });
            if (nonAllowedRow) {
                closeConnection(res, 403, 'Forbidden');
                return;
            }
            let hasInvalidChange = false;
            await Promise.all(
                rows.map(async (row) => {
                    const isChangeValid = await this.changeValidator(ensureNotFalsy(authData), row);
                    if (!isChangeValid) {
                        hasInvalidChange = true;
                    }
                })
            );
            if (hasInvalidChange) {
                closeConnection(res, 403, 'Forbidden');
                return;
            }

            const conflicts = await replicationHandler.masterWrite(rows);
            res.setHeader('Content-Type', 'application/json');

            console.log('push result:');
            console.dir(conflicts);
            res.json(conflicts);
        });
        this.server.expressApp.get('/' + this.urlPath + '/pullStream', async (req, res) => {

            console.log('##### new pullStream request');

            res.writeHead(200, {
                /**
                 * Use exact these headers to make is less likely
                 * for people to have problems.
                 * @link https://www.youtube.com/watch?v=0PcMuYGJPzM
                 */
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Connection': 'keep-alive',
                'Cache-Control': 'no-cache',
                /**
                 * Required for nginx
                 * @link https://stackoverflow.com/q/61029079/3443137
                 */
                'X-Accel-Buffering': 'no'
            });
            res.flushHeaders();

            const subscription = replicationHandler.masterChangeStream$.pipe(
                mergeMap(async (changes) => {
                    /**
                     * The auth-data might be expired
                     * so we re-run the auth parsing each time
                     * before emitting an event.
                     */
                    let authData: RxServerAuthData<AuthType>;
                    try {
                        authData = await server.authHandler(req.headers);
                    } catch (err) {
                        closeConnection(res, 401, 'Unauthorized');
                        return null;
                    }

                    console.log('S: emit to stream:');
                    console.dir(changes);

                    if (changes === 'RESYNC') {
                        return changes;
                    } else {
                        const docDataMatcherStream = await getDocAllowedMatcher(this, ensureNotFalsy(authData));
                        const useDocs = changes.documents.filter(d => docDataMatcherStream(d as any));
                        return {
                            documents: useDocs,
                            checkpoint: changes.checkpoint
                        };
                    }
                }),
                filter(f => f !== null && (f === 'RESYNC' || f.documents.length > 0))
            ).subscribe(filteredAndModified => {
                res.write('data: ' + JSON.stringify(filteredAndModified) + '\n\n');
            });

            /**
             * @link https://youtu.be/0PcMuYGJPzM?si=AxkczxcMaUwhh8k9&t=363
             */
            req.on('close', () => {
                subscription.unsubscribe();
                res.end();
            });
        });
    }
}


async function closeConnection(response: Response, code: number, message: string) {
    console.log('# CLOSE CONNECTION');
    const responseWrite = {
        code,
        error: true,
        message
    };

    console.log('close connection!');
    response.statusCode = code;
    response.set("Connection", "close");
    await response.write(JSON.stringify(responseWrite));
    response.end();
}

async function getDocAllowedMatcher<RxDocType, AuthType>(
    endpoint: RxServerReplicationEndpoint<any, RxDocType>,
    authData: RxServerAuthData<AuthType>
) {
    const useQuery: FilledMangoQuery<RxDocType> = await endpoint.queryModifier(
        authData,
        normalizeMangoQuery(
            endpoint.collection.schema.jsonSchema,
            {}
        )
    );
    const docDataMatcher = getQueryMatcher(endpoint.collection.schema.jsonSchema, useQuery);
    return docDataMatcher;
}
