'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { CreditCard, Loader2 } from 'lucide-react';
import { useRouter } from '@/platform/i18n/navigation';
import { useCheckout } from '../checkout-provider';
import { selectPaymentPreference } from '../actions';
import { plainText } from '../../plain-text';
import {useTranslations} from 'next-intl';

interface PaymentStepProps {
  onComplete: () => void;
}

export default function PaymentStep({ onComplete }: PaymentStepProps) {
  const t = useTranslations('Checkout');
  const router = useRouter();
  const { paymentMethods, selectedPaymentMethodCode, setSelectedPaymentMethodCode } = useCheckout();
  const [submitting, setSubmitting] = useState(false);

  const handleContinue = async () => {
    if (!selectedPaymentMethodCode) return;
    setSubmitting(true);
    try {
      await selectPaymentPreference(selectedPaymentMethodCode);
      await router.refresh();
      onComplete();
    } catch (error) {
      console.error('Error saving payment method:', error);
    } finally {
      setSubmitting(false);
    }
  };

  if (paymentMethods.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">{t('noPaymentMethods')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h3 className="font-semibold">{t('selectPaymentMethod')}</h3>

      <RadioGroup value={selectedPaymentMethodCode || ''} onValueChange={setSelectedPaymentMethodCode}>
        {paymentMethods.map((method) => (
          <Label key={method.code} htmlFor={method.code} className="cursor-pointer">
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <RadioGroupItem value={method.code} id={method.code} />
                <CreditCard className="h-5 w-5 text-muted-foreground" />
                <div className="flex-1">
                  <p className="font-medium">{method.name}</p>
                  {plainText(method.description) && (
                    <p className="text-sm text-muted-foreground">{plainText(method.description)}</p>
                  )}
                </div>
              </div>
            </Card>
          </Label>
        ))}
      </RadioGroup>

      <Button
        onClick={handleContinue}
        disabled={!selectedPaymentMethodCode || submitting}
        className="w-full"
      >
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('continueToShipping')}
      </Button>
    </div>
  );
}
