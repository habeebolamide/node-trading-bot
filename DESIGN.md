---
name: Strategy platform
description: Calm operator workspace for independent paper strategies
colors:
  primary: '#245c4d'
  ink: '#202e2b'
  muted: '#5c6862'
  canvas: '#f5f5f0'
  rail: '#eff1e9'
  separator: '#d9ded5'
  field: '#ffffff'
  warning-bg: '#fff0d6'
  warning-ink: '#714326'
  success-bg: '#dfecdf'
  success-ink: '#22563a'
typography:
  display:
    fontFamily: Public Sans Variable, sans-serif
    fontSize: clamp(26px, 3vw, 36px)
    fontWeight: 580
    lineHeight: 1.15
    letterSpacing: -0.03em
  body:
    fontFamily: Public Sans Variable, sans-serif
    fontSize: 14px
    lineHeight: 1.65
rounded:
  field: 5px
  button: 6px
  form: 8px
spacing:
  small: 8px
  medium: 16px
  large: 24px
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.field}'
    rounded: '{rounded.button}'
    padding: 0.65rem 0.9rem
---

# Dashboard design

## Overview

Operate mode. The user approved a calm, light workspace, portfolio table, focused bot details and prominent unresolved-exposure warnings. Rows carry operational information; the interface uses real ledger projections and explicit paper terminology.

## Colors

Warm paper canvas, dark ink and a forest accent. Amber surfaces explain unresolved exposure; red badges distinguish errors and unknown state. Secondary text uses muted green ink with readable contrast.

## Typography

Self-hosted Public Sans Variable. Financial values use tabular numerals. Headings use restrained weight and negative tracking; body text has a 75-character maximum measure. Data tables use 12px type and 11px column headings.

## Layout

A sticky 212px rail and flexible main workspace on desktop, reduced to 172px below 1000px. Below 650px the rail becomes top navigation, forms stack, and each table scrolls inside its own section. Section separation is 38px; table rows use 16px vertical padding. The login view has a 650px maximum width.

## Elevation & Depth

Flat surfaces separated by fine borders; no decorative shadows. Grouped forms use a pale green surface.

## Shapes

Small functional radii: 4px badges, 5px fields, 6px buttons and alerts, 8px create form. No decorative image assets.

## Components

Buttons use a forest primary action, bordered secondary actions and underlined navigation links. Inputs have visible labels and focus outlines. State badges distinguish operational and lifecycle state. Tables expose lifecycle quantities and separate desired, submitted and confirmed stops. Details disclosures contain immutable evidence and large JSON reports. Error, loading, empty, disabled and success states are explicit.

## Do's and Don'ts

- Do label all P&L as simulated and retain exposure warnings alongside controls.
- Do show durable command status separately from request acceptance.
- Do preserve table column hierarchy and contain horizontal scrolling on small screens.
- Don't fabricate balances, performance history or healthy projections.
- Don't imply that acknowledgment resumes a bot or that pause/stop closes a position.
