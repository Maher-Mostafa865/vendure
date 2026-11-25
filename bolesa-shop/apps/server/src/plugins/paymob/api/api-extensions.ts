import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    type PaymobCredentialSet {
        baseUrl: String!
        publicKey: String!
        apiKeyLast4: String!
        secretKeyLast4: String!
        hmacSecretLast4: String!
        integrationIdsByCurrency: JSON!
        iframeId: String
        configured: Boolean!
    }

    type PaymobConnection {
        id: ID
        mode: String!
        isActive: Boolean!
        marketCountry: String!
        testCredentials: PaymobCredentialSet!
        liveCredentials: PaymobCredentialSet!
    }

    input PaymobCredentialInput {
        baseUrl: String
        apiKey: String
        secretKey: String
        publicKey: String
        hmacSecret: String
        integrationIdsByCurrency: JSON
        iframeId: String
    }

    input UpdatePaymobConnectionInput {
        mode: String
        isActive: Boolean
        marketCountry: String
        testCredentials: PaymobCredentialInput
        liveCredentials: PaymobCredentialInput
    }

    extend type Query {
        paymobConnection: PaymobConnection!
    }

    type PaymobSettleResult {
        ok: Boolean!
        settled: Boolean!
        message: String!
    }

    extend type Mutation {
        updatePaymobConnection(input: UpdatePaymobConnectionInput!): PaymobConnection!
        """Confirm a stuck Authorized Paymob payment via Paymob transaction inquiry, then settle."""
        settlePaymobPayment(orderCode: String!): PaymobSettleResult!
    }
`;
