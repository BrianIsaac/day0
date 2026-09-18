# Logistics desk handbook

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration. Every shipment,
carrier, customer and message on this page is invented.

The logistics desk handles shipment exceptions. A shipment that is held, late or damaged gets an
exception ticket in Linear; the desk records what happened and what the customer is told, and the
account team sends the customer notice from the ticket.

- Team: `LOG`
- Project: `Shipment exceptions`
- Channels: #logistics-desk, #ops-requests

`#logistics-desk` is the desk's channel, where the warehouse and the account team raise and follow
exceptions; `#ops-requests` is the company's shared request channel. Questions for the desk lead,
drafts and escalations go to the manager DM.

## What the desk uses

- Linear, team `LOG`, project `Shipment exceptions`: one ticket per exception. The ticket title
  names the shipment, what happened, where, the carrier and whether a revised ETA has been given.
- Slack: `#logistics-desk`, `#ops-requests` and the manager DM.

## The exception process

1. Read the exception ticket: the shipment, where it is held or how late it is, the carrier, and
   whether the carrier has given a revised ETA.
2. Choose the customer notice from the two templates below.
3. Record the exception on the ticket as one comment, in the format in
   `How to record a shipment exception`, with the customer notice text in it.
4. Once the comment is posted, move the ticket to `Done`. The account team sends the notice from
   the ticket.

## Customer notice templates

**Delay, revised ETA confirmed**

> Your shipment <shipment> is delayed. <carrier> has confirmed a revised delivery date of <date>.
> We are sorry for the delay.

**Delay, ETA unconfirmed, next update by <time>**

> Your shipment <shipment> is delayed at <where>. <carrier> has not yet confirmed a revised
> delivery date. We will update you by <time>.

## Notices and ETAs

A notice states a confirmed ETA; when the carrier has given none, ask the desk lead which
template to use before writing to the customer. The desk lead knows which customers accept a
notice without a date and sets the time of the next update.

Draft first: send the draft to the manager and wait for approval before anything is published,
until the manager changes that explicitly.

## Runbooks

- `How to record a shipment exception`
