import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    type BolesaConnection {
        id: ID!
        apiBaseUrl: String!
        tokenLast4: String!
        webhookApproved: Boolean!
        shipperAddress: JSON
        defaultServiceSlug: String
        shipmentCategory: String!
        creationMode: String!
        codEnabled: Boolean!
        codFeeMode: String!
        markupPercent: Float!
        isActive: Boolean!
        lastVerifiedAt: DateTime
        labelNote: String!
    }

    type BolesaConnectionTestResult {
        ok: Boolean!
        message: String!
    }

    type BolesaShipment {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        fulfillmentId: ID!
        orderId: ID!
        channelId: ID!
        trackingNumber: String
        awbReference: String
        carrierServiceSlug: String
        statusCode: String
        labelAvailability: String!
        syncStatus: String!
        codCollectionStatus: String!
        codRemittanceStatus: String!
        attempt: Int!
        lastError: String
        lastErrorAt: DateTime
        lastStatusAt: DateTime
    }

    type BolesaShipmentList {
        items: [BolesaShipment!]!
        totalItems: Int!
    }

    input UpdateBolesaConnectionInput {
        apiBaseUrl: String
        token: String
        shipperAddress: JSON
        defaultServiceSlug: String
        shipmentCategory: String
        creationMode: String
        codEnabled: Boolean
        codFeeMode: String
        markupPercent: Float
        isActive: Boolean
    }

    extend type Query {
        bolesaConnection: BolesaConnection
        bolesaShipments(syncStatus: String, take: Int, skip: Int): BolesaShipmentList!
        bolesaShipment(fulfillmentId: ID!): BolesaShipment
    }

    extend type Mutation {
        updateBolesaConnection(input: UpdateBolesaConnectionInput!): BolesaConnection!
        testBolesaConnection: BolesaConnectionTestResult!
        bolesaRetryShipment(fulfillmentId: ID!): BolesaShipment!
        bolesaCancelShipment(fulfillmentId: ID!): BolesaShipment!
        bolesaAbandonShipment(fulfillmentId: ID!): Boolean!
    }
`;

export const shopApiExtensions = gql`
    type BolesaCity {
        name: String!
        resolutionHash: String!
        countryCode: String
        governorate: String
        district: String
    }

    extend type Query {
        bolesaSearchCities(query: String!): [BolesaCity!]!
    }
`;
