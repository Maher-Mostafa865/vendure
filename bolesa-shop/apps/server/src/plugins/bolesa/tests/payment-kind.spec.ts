import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dummyPaymentHandler } from '@vendure/core';

import { bolesaCodPaymentHandler } from '../config/bolesa-cod-payment-handler';
import { BOLESA_COD_HANDLER_CODE } from '../constants';
import { awbPaymentType, decideAutoFulfill, shouldAutoFulfill, PaymentFact } from '../util/payment-kind';

const order = { code: 'ORD1' } as any;

describe('payment handler source of truth', () => {
    it('bolesa-cod authorizes and does not settle, even if the client metadata claims otherwise', async () => {
        const result = await bolesaCodPaymentHandler.createPayment(
            {} as any,
            order,
            5000,
            [],
            { method: 'standard-payment', paymentPreference: 'prepaid' },
            {} as any,
        );
        assert.equal(result.state, 'Authorized');
        assert.equal(result.metadata?.method, 'bolesa-cod');
    });

    it('a settled non-COD handler is prepaid even when the client preference is cod', async () => {
        const result = await dummyPaymentHandler.createPayment(
            {} as any,
            order,
            5000,
            [{ name: 'automaticSettle', value: 'true' }],
            { method: 'bolesa-cod', paymentPreference: 'cod' },
            {} as any,
        );
        assert.equal(result.state, 'Settled');
        const payments: PaymentFact[] = [
            {
                state: result.state,
                methodCode: 'standard-payment',
                handlerCode: dummyPaymentHandler.code,
            },
        ];
        assert.equal(decideAutoFulfill('PaymentAuthorized', payments), 'skip');
        assert.equal(decideAutoFulfill('PaymentSettled', payments), 'prepaid-settled');
        assert.equal(awbPaymentType(payments, 'cod'), 'cc');
    });

    it('COD fulfillment waits for authorization of the bolesa-cod handler', async () => {
        const created = await bolesaCodPaymentHandler.createPayment({} as any, order, 8000, [], {}, {} as any);
        const payments: PaymentFact[] = [
            {
                state: created.state,
                methodCode: 'cash-on-delivery',
                handlerCode: BOLESA_COD_HANDLER_CODE,
            },
        ];
        assert.equal(decideAutoFulfill('PaymentAuthorized', payments), 'cod-authorized');
        assert.equal(decideAutoFulfill('PaymentSettled', payments), 'skip');
        assert.equal(awbPaymentType(payments, 'prepaid'), 'cod');
    });

    it('ignores declined, cancelled, and client-labelled payments', () => {
        const declined: PaymentFact = {
            state: 'Declined',
            methodCode: 'cash-on-delivery',
            handlerCode: BOLESA_COD_HANDLER_CODE,
        };
        const labelled: PaymentFact = {
            state: 'Settled',
            methodCode: 'standard-payment',
            handlerCode: 'dummy-payment-handler',
        };
        assert.equal(decideAutoFulfill('PaymentAuthorized', [declined]), 'skip');
        assert.equal(decideAutoFulfill('PaymentSettled', [declined, labelled]), 'prepaid-settled');
    });

    it('does not fulfill twice when a Bolesa fulfillment already exists', () => {
        const cod: PaymentFact = {
            state: 'Authorized',
            methodCode: 'cash-on-delivery',
            handlerCode: BOLESA_COD_HANDLER_CODE,
        };
        assert.equal(
            shouldAutoFulfill({ toState: 'PaymentAuthorized', payments: [cod], hasBolesaFulfillment: false }),
            true,
        );
        assert.equal(
            shouldAutoFulfill({ toState: 'PaymentAuthorized', payments: [cod], hasBolesaFulfillment: true }),
            false,
        );
    });

    it('keeps a second settled card from turning an authorized COD order into prepaid', () => {
        const payments: PaymentFact[] = [
            { state: 'Authorized', methodCode: 'cash-on-delivery', handlerCode: BOLESA_COD_HANDLER_CODE },
            { state: 'Settled', methodCode: 'standard-payment', handlerCode: 'dummy-payment-handler' },
        ];
        assert.equal(decideAutoFulfill('PaymentAuthorized', payments), 'cod-authorized');
        assert.equal(decideAutoFulfill('PaymentSettled', payments), 'skip');
        assert.equal(awbPaymentType(payments, 'prepaid'), 'cod');
    });
});
