import type { Tone } from '@/vdb/components/ui/status-badge.js';
import { cn } from '@/vdb/lib/utils.js';
import { orderStateDictionary } from '@/vdb/utils/state-type.js';
import {
    BadgeCheck,
    Ban,
    CircleAlert,
    CircleCheck,
    CircleDashed,
    CircleDot,
    CircleX,
    Clock,
    CreditCard,
    FilePen,
    Package,
    PackageCheck,
    PackageOpen,
    Pencil,
    ShieldCheck,
    ShoppingCart,
    Truck,
    Wallet,
    type LucideIcon,
} from 'lucide-react';

export type StateVisual = {
    icon: LucideIcon;
    className: string;
};

const toneFallback: Record<Tone, StateVisual> = {
    critical: { icon: CircleX, className: 'text-destructive' },
    success: { icon: CircleCheck, className: 'text-success' },
    warning: { icon: CircleAlert, className: 'text-warning' },
    info: { icon: CircleDashed, className: 'text-info' },
    progress: { icon: Pencil, className: 'text-primary' },
    neutral: { icon: CircleDashed, className: 'text-muted-foreground' },
};

/**
 * One icon and semantic color per order, payment, and fulfillment state.
 * Shared names (Shipped, Delivered, Cancelled) keep the same mark in every
 * control so the three status menus read as one system.
 */
const stateVisuals: Record<string, StateVisual> = {
    Created: { icon: CircleDot, className: 'text-muted-foreground' },
    Draft: { icon: FilePen, className: 'text-muted-foreground' },
    AddingItems: { icon: ShoppingCart, className: 'text-primary' },
    ArrangingPayment: { icon: CreditCard, className: 'text-warning' },
    PaymentAuthorized: { icon: ShieldCheck, className: 'text-info' },
    PaymentSettled: { icon: BadgeCheck, className: 'text-success' },
    PartiallyShipped: { icon: PackageOpen, className: 'text-primary' },
    Shipped: { icon: Truck, className: 'text-foreground' },
    PartiallyDelivered: { icon: Package, className: 'text-info' },
    Delivered: { icon: PackageCheck, className: 'text-success' },
    Modifying: { icon: Pencil, className: 'text-primary' },
    ArrangingAdditionalPayment: { icon: Wallet, className: 'text-warning' },
    Cancelled: { icon: CircleX, className: 'text-destructive' },
    Authorized: { icon: ShieldCheck, className: 'text-info' },
    Settled: { icon: BadgeCheck, className: 'text-success' },
    Declined: { icon: Ban, className: 'text-destructive' },
    Error: { icon: CircleAlert, className: 'text-destructive' },
    Pending: { icon: Clock, className: 'text-warning' },
    Completed: { icon: CircleCheck, className: 'text-success' },
};

export function getToneVisual(tone: Tone = 'neutral'): StateVisual {
    return toneFallback[tone];
}

export function getStateVisual(state: string): StateVisual {
    return stateVisuals[state] ?? toneFallback[orderStateDictionary.toneFor(state)];
}

export function StateStatusIcon({
    state,
    className,
}: Readonly<{ state: string; className?: string }>) {
    const visual = getStateVisual(state);
    const Icon = visual.icon;
    return <Icon className={cn('h-4 w-4', visual.className, className)} aria-hidden />;
}
