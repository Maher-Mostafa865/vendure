import { Button } from '@/vdb/components/ui/button.js';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/vdb/components/ui/dropdown-menu.js';
import type { Tone } from '@/vdb/components/ui/status-badge.js';
import { cn } from '@/vdb/lib/utils.js';
import { getStateVisual, getToneVisual } from '@/vdb/utils/state-visual.js';
import { Trans } from '@lingui/react/macro';
import { EllipsisVertical } from 'lucide-react';

export type StateTransitionAction = {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    /** Target state, used to pick a distinct icon and color. */
    state?: string;
    tone?: Tone;
    /** Marks an irreversible transition (e.g. cancel) so it renders with destructive styling. */
    destructive?: boolean;
};

type StateTransitionControlProps = {
    currentState: string;
    statesTranslationFunction: (state: string) => string;
    actions: StateTransitionAction[];
    isLoading?: boolean;
};

export function StateTransitionControl({
    currentState,
    statesTranslationFunction,
    actions,
    isLoading,
}: Readonly<StateTransitionControlProps>) {
    const currentVisual = getStateVisual(currentState);
    const CurrentIcon = currentVisual.icon;

    return (
        <div className="flex min-w-0">
            <div
                className={cn(
                    'inline-flex flex-nowrap items-center justify-start gap-1 h-8 rounded-md px-3 text-xs font-medium border border-input bg-background min-w-0',
                    actions.length > 0 && 'rounded-r-none',
                )}
                title={statesTranslationFunction(currentState)}
            >
                <div className="flex-shrink-0">
                    <CurrentIcon className={cn('h-4 w-4', currentVisual.className)} />
                </div>
                <span className={cn('truncate', currentVisual.className)}>
                    {statesTranslationFunction(currentState)}
                </span>
            </div>
            {actions.length > 0 && (
                <DropdownMenu>
                    <DropdownMenuTrigger render={<Button
                            variant="outline"
                            size="sm"
                            disabled={isLoading}
                            className={cn('rounded-l-none border-l-0 shadow-none', 'bg-background')}
                            data-testid="state-transition-trigger"
                        />}>
                        <EllipsisVertical className="h-4 w-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-48">
                        {actions.map((action, index) => {
                            const actionVisual = action.state
                                ? getStateVisual(action.state)
                                : action.destructive
                                  ? getStateVisual('Cancelled')
                                  : getToneVisual(action.tone);
                            const ActionIcon = actionVisual.icon;
                            return (
                                <DropdownMenuItem
                                    key={action.label + index}
                                    onClick={action.onClick}
                                    variant={action.destructive ? 'destructive' : 'default'}
                                    disabled={action.disabled || isLoading}
                                >
                                    <ActionIcon className={cn('h-4 w-4', actionVisual.className)} />
                                    <Trans>{action.label}</Trans>
                                </DropdownMenuItem>
                            );
                        })}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </div>
    );
}
