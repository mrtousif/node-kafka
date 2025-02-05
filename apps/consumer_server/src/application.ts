import { Server } from "http";
import Fastify, { FastifyInstance } from "fastify";
// plugins
import mercurius from "mercurius";
import mercuriusUpload from "mercurius-upload";
import prettifier from "@mgcrea/pino-pretty-compact";
import GracefulServer from "@gquittet/graceful-server";
import fastifyCors from "fastify-cors";

import { Connection, IDatabaseDriver, MikroORM, EntityManager } from "@mikro-orm/core";
import { GraphQLSchema } from "graphql";
import { buildSchema } from "type-graphql";
import { Consumer } from "kafkajs";
// import { RedisPubSub } from "graphql-redis-subscriptions";
import { KafkaPubSub } from "graphql-kafkajs-subscriptions";

import { getContext } from "@/utils/interfaces/context.interface";
import config from "@/config";
import connectDatabase from "@/connectDatabase";
import { connectKafkaConsumer } from "@/connectKafka";

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
export const DI = {} as { em: EntityManager };
export class Application {
    public instance: FastifyInstance;
    public orm!: MikroORM<IDatabaseDriver<Connection>>;
    public server!: Server;
    public gracefulServer: any;
    public appDomain: string = config.api.domain;
    public appPort: number;
    public kafkaConsumer!: Consumer;
    public kafkaPubSub!: KafkaPubSub;

    public constructor(port = config.api.port) {
        this.appPort = port;
        this.instance = Fastify({
            logger: config.env.isTest ? false : { prettyPrint: config.env.isDev, prettifier },
            ignoreTrailingSlash: true,
            trustProxy: ["127.0.0.1"],
        });
        this.gracefulServer = GracefulServer(this.instance.server);
        this.makeApiGraceful();
        this.routes();
    }

    public async init() {
        this.instance.register(fastifyCors);
        this.orm = await connectDatabase();
        DI.em = this.orm.em.fork();

        const { consumer, pubsub } = await connectKafkaConsumer();
        this.kafkaConsumer = consumer;
        this.kafkaPubSub = pubsub;
        await this.initializeGraphql();

        this.server = this.instance.server;
        try {
            await this.instance.listen(this.appPort);
            this.gracefulServer.setReady();
        } catch (error) {
            this.orm.close();
            this.instance.log.error(error);
            process.exit(1);
        }

        return { pubsub };
    }

    private async initializeGraphql() {
        const schema: GraphQLSchema = await buildSchema({
            resolvers: [`${__dirname}/**/*.resolver.{ts,js}`],
            dateScalarMode: "isoDate",
            pubSub: this.kafkaPubSub,
            emitSchemaFile: true,
        });

        this.instance.register(mercurius, {
            schema,
            graphiql: true,
            ide: true,
            path: "/graphql",
            allowBatchedQueries: true,
            context: (request) => getContext(request, this.orm.em.fork(), this.kafkaConsumer),
            subscription: {
                onConnect: (data) => {
                    console.log("Websocket Client Connected");
                    return data;
                },
            },
        });
        this.instance.register(mercuriusUpload, {
            maxFileSize: 1000000,
            maxFiles: 10,
        });
    }

    private routes() {
        this.instance.get("/", async (_request, _reply) => {
            return { message: "God speed" };
        });
    }

    private makeApiGraceful() {
        this.gracefulServer.on(GracefulServer.READY, async () => {
            this.instance.log.info(`Server is running on ${this.appDomain}:${this.appPort} 🌟👻`);
        });

        this.gracefulServer.on(GracefulServer.SHUTTING_DOWN, () => {
            this.instance.log.warn("Server is shutting down");
        });

        this.gracefulServer.on(GracefulServer.SHUTDOWN, (error) => {
            this.instance.log.error("Server is down because of", error.message);
        });
    }
}

export default Application;
