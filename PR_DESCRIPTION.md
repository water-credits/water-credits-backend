Closes #36

## Summary

- replace flat HTTP request messages with structured Winston log entries
- include authenticated user and wallet context, request correlation IDs, status, timing, and IP address
- anonymise client IP addresses in production and record body size (never body content) for POST, PATCH, and DELETE requests
- correlate exception logs and error responses with the same request ID
- return `X-Request-Id` on responses, reusing a caller-supplied ID or generating a UUID

## Testing

- added unit coverage for authenticated mutation audit fields, request IDs, production IP anonymisation, body size, and public routes
- `npm test -- --runInBand`
- `npm run build`
