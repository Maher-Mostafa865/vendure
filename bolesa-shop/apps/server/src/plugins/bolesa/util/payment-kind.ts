import { BOLESA_COD_HANDLER_CODE } from '../constants';

/**
 * Facts taken from a persisted Vendure Payment plus the PaymentMethod handler
 * registered for that method code. `handlerCode` is server configuration.
 * Client metadata and `paymentPreference` are not consulted.
 */
export interface PaymentFact {
    state: string;
    methodCode: string;
    handlerCode: string | null;
}

const ACTIVE = new Set(['Authorized', 'Settled']);

function isCod(payment: PaymentFact): boolean {
    return payment.handlerCode === BOLESA_COD_HANDLER_CODE && ACTIVE.has(payment.state);
}

export type AutoFulfillTrigger = 'cod-authorized' | 'prepaid-settled' | 'skip';

/**
 * COD is a payment whose method uses the `bolesa-cod` handler and is Authorized.
 * That fires only on PaymentAuthorized. Any other successful payment waits for
 * PaymentSettled. A later COD settlement does not fulfill again.
 */
export function decideAutoFulfill(toState: string, payments: PaymentFact[]): AutoFulfillTrigger {
    const cod = payments.filter(isCod);
    if (cod.length > 0) {
        if (toState === 'PaymentAuthorized' && cod.some(payment => payment.state === 'Authorized')) {
            return 'cod-authorized';
        }
        return 'skip';
    }
    const settledOther = payments.some(
        payment => payment.state === 'Settled' && payment.handlerCode !== BOLESA_COD_HANDLER_CODE,
    );
    if (toState === 'PaymentSettled' && settledOther) {
        return 'prepaid-settled';
    }
    return 'skip';
}

export function shouldAutoFulfill(input: {
    toState: string;
    payments: PaymentFact[];
    hasBolesaFulfillment: boolean;
}): boolean {
    if (input.hasBolesaFulfillment) {
        return false;
    }
    return decideAutoFulfill(input.toState, input.payments) !== 'skip';
}

/**
 * AWB payment type follows the same handler facts. A client `paymentPreference`
 * is used only when the order has no successful payment yet.
 */
export function awbPaymentType(
    payments: PaymentFact[],
    preference: string | null | undefined,
): 'cc' | 'cod' {
    if (payments.some(isCod)) {
        return 'cod';
    }
    if (payments.some(payment => ACTIVE.has(payment.state))) {
        return 'cc';
    }
    return preference === 'cod' ? 'cod' : 'cc';
}
