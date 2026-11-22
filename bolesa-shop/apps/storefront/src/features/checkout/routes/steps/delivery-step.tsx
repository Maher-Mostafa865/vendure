'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Loader2, Truck } from 'lucide-react';
import { useRouter } from '@/platform/i18n/navigation';
import { useCheckout } from '../checkout-provider';
import { selectBolesaService, setShippingMethod as setShippingMethodAction } from '../actions';
import { bolesaChoicesFromMetadata, selectedBolesaSlug } from '../bolesa-choices';
import {useTranslations, useLocale} from 'next-intl';
import {toIntlLocale} from '@/platform/i18n/locale-utils';

interface DeliveryStepProps {
  onComplete: () => void;
}

export default function DeliveryStep({ onComplete }: DeliveryStepProps) {
  const t = useTranslations('Checkout');
  const locale = useLocale();
  const intlLocale = toIntlLocale(locale);
  const router = useRouter();
  const { shippingMethods, order } = useCheckout();
  const deliveryOptions = shippingMethods.flatMap((method) => {
    if (method.code !== 'bolesa-shipping') {
      return [{
        key: method.id,
        methodId: method.id,
        slug: null as string | null,
        name: method.name,
        label: method.description,
        logoUrl: undefined as string | undefined,
        price: method.priceWithTax,
      }];
    }
    const choices = bolesaChoicesFromMetadata(method.metadata);
    if (choices.length === 0) {
      return [{
        key: method.id,
        methodId: method.id,
        slug: null,
        name: method.name,
        label: method.description,
        logoUrl: undefined,
        price: method.priceWithTax,
      }];
    }
    return choices.map((choice) => ({
      key: `bolesa:${choice.slug}`,
      methodId: method.id,
      slug: choice.slug,
      name: choice.name,
      label: choice.label,
      logoUrl: choice.logoUrl,
      price: choice.priceMinor,
    }));
  });
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(() => {
    const bolesa = shippingMethods.find((method) => method.code === 'bolesa-shipping');
    const currentLine = order.shippingLines?.[0];
    if (bolesa && currentLine?.shippingMethod.id === bolesa.id) {
      const slug = selectedBolesaSlug(bolesa.metadata);
      if (slug) {
        return `bolesa:${slug}`;
      }
    }
    if (currentLine) {
      return currentLine.shippingMethod.id;
    }
    return deliveryOptions.length === 1 ? deliveryOptions[0].key : null;
  });
  const [submitting, setSubmitting] = useState(false);

  const handleContinue = async () => {
    const selected = deliveryOptions.find((option) => option.key === selectedMethodId);
    if (!selected) return;

    setSubmitting(true);
    try {
      if (selected.slug) {
        await selectBolesaService(selected.slug);
      }
      await setShippingMethodAction(selected.methodId);
      router.refresh();
      onComplete();
    } catch (error) {
      console.error('Error setting shipping method:', error);
    } finally {
      setSubmitting(false);
    }
  };

  if (deliveryOptions.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">{t('noShippingMethods')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h3 className="font-semibold">{t('selectShippingMethod')}</h3>

      <RadioGroup value={selectedMethodId || ''} onValueChange={setSelectedMethodId}>
        {deliveryOptions.map((option) => (
          <Label key={option.key} htmlFor={option.key} className="cursor-pointer">
            <Card className="p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 flex-1">
                  <RadioGroupItem value={option.key} id={option.key} />
                  {option.logoUrl ? (
                    <img
                      src={option.logoUrl}
                      alt=""
                      className="h-8 w-8 rounded object-contain bg-white"
                    />
                  ) : (
                    <Truck className="h-5 w-5 text-muted-foreground" />
                  )}
                  <div>
                    <p className="font-medium">{option.name}</p>
                    {option.label && (
                      <p className="text-sm text-muted-foreground mt-1">
                        {option.label}
                      </p>
                    )}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="font-semibold">
                    {option.price === 0
                      ? t('free')
                      : (option.price / 100).toLocaleString(intlLocale, {
                          style: 'currency',
                          currency: order.currencyCode || 'USD',
                        })}
                  </p>
                </div>
              </div>
            </Card>
          </Label>
        ))}
      </RadioGroup>

      <Button
        onClick={handleContinue}
        disabled={!selectedMethodId || submitting}
        className="w-full"
      >
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('continueToPayment')}
      </Button>
    </div>
  );
}
