import { LanguageCode, PaymentMethodEligibilityChecker } from '@vendure/core';

import { PAYMOB_ELIGIBILITY_CHECKER_CODE } from '../constants';
import { PaymobConnectionService } from '../services/paymob-connection.service';
import { pickStoredCredentials } from '../util/credentials';

let connectionService: PaymobConnectionService | undefined;

export const paymobEligibilityChecker = new PaymentMethodEligibilityChecker({
    code: PAYMOB_ELIGIBILITY_CHECKER_CODE,
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'Paymob is available when the channel has an active connection with credentials for the selected mode',
        },
    ],
    args: {},
    init(injector) {
        connectionService = injector.get(PaymobConnectionService);
    },
    check: async ctx => {
        if (!connectionService) {
            return false;
        }
        try {
            const conn = await connectionService.getForChannel(ctx);
            if (!conn?.isActive) {
                return 'Paymob is not configured for this channel';
            }
            const stored = pickStoredCredentials(conn);
            if (!stored?.secretKeyEncrypted || !stored.publicKey || !stored.hmacSecretEncrypted) {
                return `Paymob ${conn.mode} credentials are incomplete`;
            }
            return true;
        } catch {
            return 'Paymob is not available';
        }
    },
});
