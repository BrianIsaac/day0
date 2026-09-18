# How to record a shipment exception

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration. Every shipment,
carrier and customer on this page is invented.

Each exception is recorded as one comment on its ticket in Linear team `LOG`, project
`Shipment exceptions`.

## Comment format

```text
Exception: <shipment>, <what happened>, <where>
Carrier: <carrier>; revised ETA: <the date the carrier gave, or none given>
Customer notice (<template name>):
<the notice text, with every placeholder filled>
Next update: <the time the notice promises, or none>
```

- Fill every placeholder from the ticket or from the desk lead's answer. A notice that still
  carries a `<placeholder>` is not ready.
- The template name is one of the two in the handbook, word for word.
- One comment per exception. A later update is a new comment.

## Thread reply shape

When an exception is raised in `#logistics-desk`, reply in that message's thread (its own channel
and timestamp) with the first two lines of the comment and the ticket identifier:

```text
Recorded on <ticket>: <shipment>, <what happened>, <where>. Carrier: <carrier>; revised ETA: <date, or none given>.
```
