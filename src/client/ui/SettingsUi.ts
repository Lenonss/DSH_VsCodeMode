import React from 'react'
import type { ReactElement, ReactNode } from 'react'

interface SettingRowProps {
  label: string
  description?: string
  children: ReactElement<{ id?: string; 'aria-describedby'?: string }>
}

/**
 * @public
 * @author ddj 2026年11月12号
 * @description Associate setting help with its control without squeezing long labels.
 * @param props Field name, help text and one control.
 * @returns Responsive accessible settings row.
 */
export function SettingRow(props: SettingRowProps): ReactElement {
  const fieldId = React.useId()
  const helpId = fieldId + '-help'
  const describedBy = [props.children.props['aria-describedby'], props.description ? helpId : undefined].filter(Boolean).join(' ')
  const control = React.cloneElement(props.children, { id: fieldId, 'aria-describedby': describedBy || undefined })

  return React.createElement('div', { className: 'vsm-setting-row' },
    React.createElement('div', { className: 'vsm-setting-copy' },
      React.createElement('label', { htmlFor: fieldId }, props.label),
      props.description && React.createElement('p', { id: helpId }, props.description)),
    React.createElement('div', { className: 'vsm-setting-control' }, control))
}

/**
 * @public
 * @author ddj 2026年11月12号
 * @description Announce results without moving focus or disguising errors.
 * @param props Result content and optional error severity.
 * @returns Inline status, alert or nothing.
 */
export function SettingNotice(props: { message: ReactNode; error?: boolean }): ReactElement | null {
  if (!props.message) return null

  return React.createElement('div', {
    className: props.error ? 'vsm-setting-notice error' : 'vsm-setting-notice',
    role: props.error ? 'alert' : 'status',
  }, props.message)
}
