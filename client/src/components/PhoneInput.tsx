import { formatPhoneAsYouType, normalizePhone } from "../lib/phone";

/**
 * Phone input that accepts any format and reports the canonical digits-only
 * value via onChange, while displaying it live as "(903) 555-1234".
 *
 * `value` is the stored canonical value (digits). Parent state stays canonical;
 * this component only handles presentation.
 */
export function PhoneInput({
  value,
  onChange,
  onBlur,
  disabled,
  placeholder = "(903) 555-1234",
  required,
  id,
}: {
  value: string | null | undefined;
  onChange: (canonical: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  placeholder?: string;
  required?: boolean;
  id?: string;
}) {
  return (
    <input
      id={id}
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      required={required}
      disabled={disabled}
      value={formatPhoneAsYouType(value ?? "")}
      placeholder={placeholder}
      onChange={(e) => onChange(normalizePhone(e.target.value))}
      onBlur={onBlur}
    />
  );
}
