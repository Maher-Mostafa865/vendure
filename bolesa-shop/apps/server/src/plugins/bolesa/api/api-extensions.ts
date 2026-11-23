import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    type BolesaConnection {
        id: ID!
        apiBaseUrl: String!
        tokenLast4: String!
        webhookApproved: Boolean!
        shipperAddress: JSON
        defaultServiceSlug: String
        enabledServiceSlugs: [String!]!
        serviceOffers: [BolesaServiceOffer!]!
        accountServices: [BolesaAccountService!]!
        serviceRates: [BolesaServiceRate!]!
        codMinimumMajor: Float!
        allowOpen: Boolean!
        autoCreateAwb: Boolean!
        shipmentCategory: String!
        creationMode: String!
        codEnabled: Boolean!
        codFeeMode: String!
        markupPercent: Float!
        isActive: Boolean!
        lastVerifiedAt: DateTime
        labelNote: String!
    }

    type BolesaServiceOffer {
        slug: String!
        priority: Int!
        profitMinor: Int!
    }

    input BolesaServiceOfferInput {
        slug: String!
        priority: Int!
        profitMinor: Int!
    }

    type BolesaCarrierChoice {
        slug: String!
        name: String!
        carrierPriceMinor: Int!
        profitMinor: Int!
        currencyCode: String!
    }

    type BolesaOrderCarrierChoices {
        paymentPreference: String!
        selectedSlug: String!
        choices: [BolesaCarrierChoice!]!
    }

    type BolesaAccountService {
        slug: String!
        name: String!
        logoUrl: String
    }

    """Last finite price returned by the carrier. Not the checkout price."""
    type BolesaServiceRate {
        slug: String!
        currencyCode: String!
        ccPriceMinor: Int
        codPriceMinor: Int
        quotedAt: String!
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
        partnerRequest: JSON
        partnerResponse: JSON
    }

    type BolesaShipmentList {
        items: [BolesaShipment!]!
        totalItems: Int!
    }

    type BolesaQueueHealth {
        queueName: String!
        active: Int!
        failedUnsettledLike: Int!
    }

    type BolesaChannelHealth {
        channelId: ID!
        bySyncStatus: JSON!
        stuckRequested: Int!
        stuckCancelRequested: Int!
        failed: Int!
        retryExhausted: Int!
        cancelRetryExhausted: Int!
    }

    type BolesaOpsHealth {
        generatedAt: DateTime!
        stuckThresholdMs: Int!
        channels: [BolesaChannelHealth!]!
        queues: [BolesaQueueHealth!]!
        """
        Last successful Admin testBolesaConnection (Partner /me) for the current channel.
        Not updated by create/cancel/status traffic — not a live Partner health probe.
        """
        lastConnectionTestAt: DateTime
        notes: [String!]!
    }

    input UpdateBolesaConnectionInput {
        apiBaseUrl: String
        token: String
        shipperAddress: JSON
        defaultServiceSlug: String
        enabledServiceSlugs: [String!]
        serviceOffers: [BolesaServiceOfferInput!]
        codMinimumMajor: Float
        allowOpen: Boolean
        autoCreateAwb: Boolean
        shipmentCategory: String
        creationMode: String
        codEnabled: Boolean
        codFeeMode: String
        markupPercent: Float
        isActive: Boolean
    }

    extend type Query {
        bolesaConnection: BolesaConnection
        """Services enabled on the Partner account. Prices here are not checkout prices."""
        bolesaAccountServices: [BolesaAccountService!]!
        """Carriers returned by services/options for this order, with the saved profit."""
        bolesaOrderCarrierChoices(orderId: ID!): BolesaOrderCarrierChoices!
        bolesaShipments(syncStatus: String, take: Int, skip: Int): BolesaShipmentList!
        bolesaShipment(fulfillmentId: ID!): BolesaShipment
        bolesaOpsHealth: BolesaOpsHealth!
    }

    extend type Mutation {
        updateBolesaConnection(input: UpdateBolesaConnectionInput!): BolesaConnection!
        testBolesaConnection: BolesaConnectionTestResult!
        bolesaRetryShipment(fulfillmentId: ID!): BolesaShipment!
        bolesaRetryCancelShipment(fulfillmentId: ID!): BolesaShipment!
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

    type BolesaCheckoutPolicy {
        codEnabled: Boolean!
        """Goods total, in minor units, from the payment method eligibility checker."""
        codMinimumMinor: Int!
        """Payment method codes whose handler is bolesa-cod for this channel."""
        codPaymentMethodCodes: [String!]!
    }

    extend type Query {
        bolesaSearchCities(query: String!): [BolesaCity!]!
        bolesaCheckoutPolicy: BolesaCheckoutPolicy!
    }
`;
