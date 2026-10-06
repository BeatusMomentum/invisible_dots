"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import type { ThemePreference } from "../../lib/theme";
import { useThemePreference } from "../../lib/use-theme";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../ui/dropdown-menu";

const CHOICES: { value: ThemePreference; label: string; icon: typeof SunIcon }[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
];

/** Light, dark or the system's; the choice is kept in this browser. */
export function ThemeToggle() {
  const [preference, setPreference] = useThemePreference();
  const current = CHOICES.find((choice) => choice.value === preference) ?? CHOICES[2]!;
  const Icon = current.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Theme: ${current.label}`}>
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={preference} onValueChange={(value) => setPreference(value as ThemePreference)}>
          {CHOICES.map(({ value, label, icon: ChoiceIcon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <ChoiceIcon />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
