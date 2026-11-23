'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Loader2, Truck } from 'lucide-react';
import { useRouter } from '@/platform/i18n/navigation';
import { useCheckout } from '../checkout-provider';
import { setShippingMethod as setShippingMethodAction } from '../actions';
import { isBolesaShippingCode } from '../bolesa-choices';
import { Price } from '@/features/pricing/price';
import {useTranslations} from 'next-intl';

interface DeliveryStepProps {
  onComplete: () => void;
}

export default function DeliveryStep({ onComplete }: DeliveryStepProps) {
  const t = useTranslations('Checkout');
  const router = useRouter();
  const { shippingMethods, order } = useCheckout();
  const methods = shippingMethods.filter((method) => isBolesaShippingCode(method.code));
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(() => {
    const currentLine = order.shippingLines?.[0];
    if (currentLine && methods.some((method) => method.id === currentLine.shippingMethod.id)) {
      return currentLine.shippingMethod.id;
    }
    return methods.length === 1 ? methods[0].id : null;
  });
  const [submitting, setSubmitting] = useState(false);

  const handleContinue = async () => {
    if (!selectedMethodId) return;

    setSubmitting(true);
    try {
      await setShippingMethodAction(selectedMethodId);
      await router.refresh();
      onComplete();
    } catch (error) {
      console.error('Error setting shipping method:', error);
    } finally {
      setSubmitting(false);
    }
  };

  if (methods.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">{t('noShippingMethods')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h3 className="font-semibold">{t('selectShippingMethod')}</h3>

      <RadioGroup value={selectedMethodId || ''} onValueChange={setSelectedMethodId} className="gap-3">
        {methods.map((method) => {
          const selected = selectedMethodId === method.id;
          return (
            <Label key={method.id} htmlFor={method.id} className="cursor-pointer">
              <Card className={`w-full p-4 ${selected ? 'border-primary ring-1 ring-primary/30' : ''}`}>
                <div className="flex items-center gap-3">
                  <RadioGroupItem value={method.id} id={method.id} />
                  <Truck className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{t('standardShipping')}</p>
                  </div>
                  <p className="shrink-0 font-semibold">
                    {method.priceWithTax === 0
                      ? t('free')
                      : <Price value={method.priceWithTax} currencyCode={order.currencyCode} />}
                  </p>
                </div>
              </Card>
            </Label>
          );
        })}
      </RadioGroup>

      <Button
        onClick={handleContinue}
        disabled={!selectedMethodId || submitting}
        className="w-full"
      >
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('continueToReview')}
      </Button>
    </div>
  );
}
