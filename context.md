


Here is the detailed summary of your requirements for the offline-first, peer-to-peer (P2P) POS system:
**1. Hardware & Environment**
- **Devices:** Exclusively Android-based tablets, specifically targeting **Amazon Fire Tablets** and standard **Android** devices.
- **Connectivity:** Operates in an **offline environment** (no internet). Communication must happen over a **Local Area Network (LAN)** via a Wi-Fi router.
- **Scale:** Support for **3–10 tablets** per independent instance.
- **Multi-Tenancy:** The network may host up to **30 independent instances** (e.g., 30 food trucks) simultaneously. Tablets from one truck must remain **independent** and only sync with their specific group, ignoring data from other trucks on the same network.

**2. Architectural Requirements**
- **Decentralized (No Central Server):** You explicitly rejected a "master" tablet or central PC/server to avoid a single point of failure. If one tablet goes down, the others must continue to function and sync seamlessly.
- **Peer-to-Peer (P2P) Sync:** Data (orders) must be shared directly between tablets.
- **Shared Data Model:** All tablets within a group must have a synchronized list of orders (mini-database or shared JSON).
- **Local-First:** Each tablet must maintain its own local "DB" to ensure the UI remains fast and functional even if the local Wi-Fi drops momentarily.

**3. Development & Deployment Goals**
- **Simplified Deployment:** You want to avoid complex external dependencies or server setups to make it easy to deploy across many units.
- **Custom "DB" Solution:** You prefer a custom or lightweight database implementation rather than a heavy, managed enterprise solution.
- **Technology Stack:** The implementation will most likely use **React Native**.

**4. Functional Logic**
- **Discovery:** Tablets must automatically find their "peers" (tablets belonging to the same truck) without manual IP entry.
- **Synchronization:** Data must flow between all active tablets so that an order created on Tablet A appears on Tablets B through J.
- **Conflict Handling:** The system needs a logic (like timestamps) to handle situations where multiple tablets might update the same order.

**What’s missing to move to the implementation phase:**
- How will you **assign the unique "Truck ID"** to a group of tablets (e.g., hardcoded, QR code scan, or a setup menu)?
- Do the tablets ever need to **offload this data to the cloud** later (e.g., for end-of-day reporting), or is it 100% local forever?
- Do you have a preference for **data persistence** (e.g., keeping order history for days, or clearing the "DB" every 24 hours)?

Thought for 12s
You’re basically describing a local-first replicated database running on 3–10 Android tablets, with automatic peer discovery and gossip-style syncing, and strict multi-tenant separation (up to ~30 trucks on the same LAN).

Below is a concrete, “let’s build it” implementation plan + recommended answers to the 3 missing items.

Recommended answers to what’s missing
1) Assigning a unique Truck ID (grouping tablets)
Use QR-code provisioning during a 30–60 second “join truck” setup:

One tablet creates a new truck:

generates: truckId (random, like TRK-8F3K…)

generates: truckSecret (random 128-bit secret; used to authenticate/encrypt sync)

It shows a QR with {truckId, truckSecret, optional displayName}

Other tablets scan and store it locally.

Why this is the best fit:

no typing IPs

no central “master” long-term

strong separation between trucks even on same LAN

Fallback: manual “enter code” if camera is unavailable.

2) Offload to cloud later?
Design it so it’s optional and doesn’t affect offline ops.

Core system is 100% LAN-only

Add an optional “Export” feature:

export JSON/CSV to a USB drive, Bluetooth, or “upload later when internet exists”

or a future cloud sync module that just consumes the local DB

This keeps deployment simple now, but doesn’t paint you into a corner.

3) Data persistence / retention
Default recommendation for food trucks:

Keep today + last 7 days of orders locally (configurable).

Add a “Close day” workflow:

marks day closed

optionally archives + compresses old data

allows “wipe after export” if they want ultra-simple devices

You’ll be glad you kept at least some history for troubleshooting refunds, “where is my order”, etc.

Implementation architecture (no server, no master)
A) Local-first storage on every tablet
Use a real embedded DB (still lightweight):

SQLite (via RN) for reliability + queryability

Store:

orders (current materialized state)

oplog (append-only operations for replication)

peers (seen devices)

sync_state (what we’ve exchanged with each peer)

This isn’t a “managed enterprise solution” — it’s just a file on the tablet, but it saves you from reinventing crash safety.

B) Peer discovery (no manual IP entry)
On the LAN you need “find peers belonging to my truck”.

Best practical approach on Android/Fire Tablets:

Use Android NSD (Network Service Discovery / mDNS) to advertise a service like:

service type: _pos-sync._tcp

TXT records: {truckId, deviceId, protoVer}

Tablets browse for _pos-sync._tcp and will see all trucks, but they only connect to those with matching truckId.

If mDNS is flaky on a given router/firewall (sometimes happens):

fallback to UDP broadcast discovery:

send “hello” packets to 255.255.255.255:PORT

include truckId, deviceId

peers respond with their reachable IP/port

In practice, I’d implement NSD first + UDP fallback.

C) Transport: device-to-device sync
Each tablet runs a tiny local service:

HTTP over TCP on a local port (e.g., 33445)

Endpoints like:

POST /sync/hello

POST /sync/pull

POST /sync/push

All traffic is authenticated with truckSecret (and ideally encrypted—see security note below).

No “server” here — every tablet both serves and calls.

Sync model that actually works offline (and avoids conflicts)
Core idea: replicate an operation log (oplog), not whole DB
When something happens (create order, add item, mark paid), you write an operation:

{
  "opId": "ULID...",
  "truckId": "TRK-...",
  "deviceId": "DEV-...",
  "lamport": 1042,
  "ts": 1709...,
  "type": "ORDER_ADD_ITEM",
  "orderId": "ORD-...",
  "payload": { "sku": "...", "qty": 1 }
}
Each tablet:

appends op to oplog

applies it to orders (materialized view)

gossips ops to peers

Anti-entropy (gossip) sync loop
Every ~1–2 seconds (or event-driven + periodic):

discover peers

for each peer:

exchange “what I have” summary

send missing ops

request missing ops

Simple summary format that scales fine for 3–10 devices:

“highest lamport seen per deviceId”

Example: { "DEV-A": 120, "DEV-B": 98, ... }

Then a peer can answer: “you’re missing ops from DEV-B 99..112” and ship them.

Conflict handling
You want to minimize “same order updated on two tablets” collisions by design:

orders typically are created on one tablet and only added to (items, status)

payments/voids are sensitive: enforce UI rules or require a manager PIN

But if conflicts do happen, use deterministic rules:

For fields like status, paid, total: Last-Write-Wins using (lamport, deviceId) ordering.

For “add item” style actions: operations commute naturally (just append line items).

For deletes/voids: use a tombstone op like ORDER_VOID that wins over later adds unless you explicitly allow “unvoid”.

This gives you “eventual consistency” that is predictable.

Multi-tenancy separation (30 trucks on same Wi-Fi)
You’ll get isolation at 3 levels:

Discovery filter: show/connect only peers advertising same truckId

Authentication: every sync request is HMAC-signed with truckSecret

if truckId matches but secret doesn’t → ignore

Encryption (recommended): encrypt payloads using a key derived from truckSecret

prevents “Truck B sniffing Truck A’s orders” on the same LAN

Even if all trucks share the same SSID/router, they won’t sync across trucks.

React Native practical stack (what you’ll actually code)
UI/App: React Native

Local DB: SQLite (RN binding)

Discovery:

RN Zeroconf wrapper or a small native module for Android NSD

UDP broadcast fallback (there are RN UDP socket libs)

Local service:

lightweight HTTP server inside the app (there are RN-friendly servers) or native module

QR provisioning:

QR generator + camera scanner libraries

If you want the absolute simplest deployment: no extra apps, no router config, just install APK and scan QR.

Suggested “v1 scope” (fast path to working system)
SQLite schema: orders, oplog, sync_state

QR provisioning (truckId + secret)

Discovery via NSD

HTTP sync push/pull with HMAC auth

Oplog replication with lamport clocks

Basic retention (keep last 7 days)

Debug screen: show peers + last sync time + op counts

That will get you a robust LAN-only POS sync that survives tablets dropping/rejoining.

If you tell me one more thing—do you need item-level editing of an existing order from multiple tablets, or is it “create on one, view everywhere, status updates from a couple devices”?—I can lock the conflict rules/UI constraints so you don’t end up with weird edge cases in production.


“Okay, one department. We should also have client phones that may run in the same Wi-Fi network. There are lots and lots of them, so they can also be part of this setup, but on their phones, it's mostly...”
00:27

Got it. You want


“IPhone, and that means that they're most likely gonna need only web application, but of course functionality is limited from servers, so the client app will only need to submit order and get menu, so it's very limited kind of data flow between client and servers.”
00:31

Understood. So, you want the client phones to access a lightweight web application on the same Wi-Fi network. This web app will let them view the menu and submit orders, with minimal data exchange and no heavy processing on their end.

Here’s how this can integrate with the existing system:

Host the Web App Locally: One of the tablets (or a dedicated lightweight device) can host a simple web server. The client devices can connect to this server over the LAN to load the web application.

Serve Menu Data: The menu data can be served as a static JSON or fetched dynamically from the hosting tablet’s local database.

Order Submission: When a client places an order, it sends the order data to the hosting tablet, which then integrates it into the local DB and propagates it through the P2P network as if it originated from a staff tablet.

Access Control: The web app can be protected by a simple authentication step or a shared secret to ensure only authorized clients can place orders.

Scalability: Since the data flow is minimal and primarily read-only for the clients, the system can scale to a large number of client devices without overloading the network.

This way, you maintain the robustness of the P2P system for the core POS operations while allowing clients to interact seamlessly with the system.


“Together.”
00:00

You're welcome! If you have any more questions or need further details as you move forward with the implementation, just let me know!


“additional requirement that any tablet, any server tablet should be able to serve as a web server because tablets are not reliable and some of them may go offline. So that's a little more complex because now it's not very clear to which tablet we need to connect the client to. So we probably need some kind of local DNS or whatever.”
00:43

Absolutely, ensuring high availability by allowing any tablet to serve as the web server is a great approach. To handle dynamic failover and make sure clients always connect to a functioning tablet, you can use a local service discovery mechanism.

Here’s how you can approach it:

Dynamic Service Discovery: Utilize a local DNS or mDNS (like Avahi or Bonjour) to advertise which tablets are currently available to serve the web app. Each tablet can announce itself as a web server on the LAN, and clients can query for the current “active” server.

Automatic Failover: If a tablet that was serving the web app goes offline, clients can automatically discover and switch to another tablet that has taken over the role. This way, the system remains resilient even if one or more tablets fail.

Load Balancing and Redundancy: While not strictly load balancing in a heavy-traffic sense, clients can connect to any available tablet, distributing the load and ensuring that no single tablet becomes a bottleneck.

Seamless Client Experience: Clients won’t need to know which tablet is the server at any given time. They can just connect to a consistent local hostname (resolved via mDNS) that points to whichever tablet is currently active.

By using mDNS or a similar local discovery protocol, you can ensure that clients always find an active tablet to serve their requests, keeping the system both robust and flexible.


“So the client will only run in a web browser, so they cannot have any app installed on their phones or anything like that. So we can only do something on our side. And ideally, I don't want any extra app on each tablet. I may have theoretically something on the router if it's needed. The router, like I can choose of my own. Yeah, that's the requirement.”
00:34

Got it, so the clients are strictly browser-based with no additional apps, and you'd prefer to avoid extra apps on the tablets as well. Leveraging the router for some functionality is an option.

In that case, here’s a refined approach:

Centralized Lightweight Proxy on the Router:

Configure the router to run a lightweight service (e.g., an NGINX reverse proxy or a simple script) that keeps track of which tablet is currently serving the web app.

The router can monitor the availability of the tablets using a simple heartbeat or health-check mechanism.

Proxy-Based Redirection:

Clients point their browsers to a single local hostname or IP (managed by the router).

The router’s proxy service forwards the client requests to the currently active tablet serving the web app.

If a tablet goes offline, the router can automatically reroute traffic to another available tablet.

Minimal Configuration on Tablets:

Tablets continue to run a local web server for the POS web app.

The router handles the discovery and failover logic, so no extra configuration or apps are needed on each tablet.

Router Capability:

You mentioned you can choose your own router, so opting for a router that supports custom scripts or has an environment like OpenWRT would make this feasible. This setup allows for a flexible and robust environment without needing additional software on the tablets or clients.

This way, the clients simply connect to a single consistent address, and the router handles the dynamic routing to the appropriate tablet. This maintains the offline-first, P2P nature of the system while ensuring high availability and minimal complexity on the tablets and client devices.


not sure I understand hat exactly we need to run on the router, let say we have tablets running on .2 and .3 , and router running on .1 , what ip or url client should connect to ?

Thought for 7s
Think of the router as the one stable “front door” (because it’s always .1). The tablets (.2, .3, …) are the backends that can come and go.

So the client should connect to the router, and the router forwards to whichever tablet is alive.

What URL/IP does the client use?
Client connects to:

Option A (simplest): http://10.0.0.1/ (router IP)

Option B (nicer): http://pos.local/ (or http://truck23.local/) which the router resolves to 10.0.0.1

Either way, the browser is talking to the router at .1.

What runs on the router?
You run two small things:

1) A local DNS name (optional but nice)
On the router (OpenWrt typically uses dnsmasq), map a name to the router:

pos.local -> 10.0.0.1

So customers type pos.local instead of an IP.

If you don’t care about a name, skip this; just use http://10.0.0.1.

2) A reverse proxy / load balancer (this is the important part)
Run one tiny proxy on the router (common choices: HAProxy or nginx) that:

listens on port 80/443 on 10.0.0.1

forwards requests to an alive tablet, e.g. 10.0.0.2:8080 or 10.0.0.3:8080

does health checks (so if .2 is down, it automatically uses .3)

So from the client’s point of view:

they always open http://10.0.0.1 (or pos.local)

the router silently sends them to a working tablet

Concrete example (how routing works)
Let’s say tablets run the web server on port 8080:

Tablet A: 10.0.0.2:8080

Tablet B: 10.0.0.3:8080

Router: 10.0.0.1

Client opens:

http://10.0.0.1

Router proxy logic:

if .2 responds to health check → forward to .2

else forward to .3

if .2 comes back later → it can be used again automatically

Why you can’t solve this with “just DNS” (important)
You could make DNS return .2 or .3, but:

iPhones cache DNS

there’s no guaranteed fast failover

you can’t reliably health-check and switch

That’s why the router-as-proxy is the clean solution.

How do clients find it without typing anything?
Two common options (pick one):

QR code on the truck: encodes http://pos.local (or http://10.0.0.1)

Router captive portal: when they join Wi-Fi it auto-opens the menu page (still fully local)

If you tell me what router OS you’re willing to use (OpenWrt okay? GL.iNet okay?), I can give you an exact minimal config (HAProxy/nginx + dnsmasq) you can copy-paste.


what if I have multiple clusters , so the second cluster will have .4 and .5 for example 

Thought for 13s
If you have multiple independent clusters (trucks) on the same router / same Wi-Fi, then the router can’t just be “the front door” for one cluster anymore — it has to be a front door for many clusters, and it must know which truck a given customer is trying to reach.

With truck #1 tablets on .2/.3 and truck #2 tablets on .4/.5, you have two clean patterns.

Option 1 (recommended if you can): separate SSID/VLAN per truck
You create one SSID per truck (or per few trucks), each mapped to its own VLAN + subnet:

Truck1 SSID → subnet 10.10.1.0/24 (router is 10.10.1.1)

Truck2 SSID → subnet 10.10.2.0/24 (router is 10.10.2.1)

…

Client connects to the truck’s Wi-Fi, then opens:

http://10.10.1.1 (for Truck1)

http://10.10.2.1 (for Truck2)

This is the simplest operationally because trucks are isolated automatically (broadcast, discovery, noise, accidental cross-truck traffic).

Downside: You’ll manage many SSIDs/VLANs if you truly have 30 trucks.

Option 2 (single SSID / single subnet): route by hostname (virtual hosting)
Keep everything in one subnet like 10.0.0.0/24, router is 10.0.0.1, and tablets are .2/.3/.4/.5/....

Then you give each truck a unique URL name, and the router proxy routes based on the HTTP Host header:

Truck1 URL: http://truck1.pos/ → router forwards to .2/.3

Truck2 URL: http://truck2.pos/ → router forwards to .4/.5

What does the client connect to?
They still connect to the router, but using a truck-specific hostname:

Truck1 customers: http://truck1.pos/

Truck2 customers: http://truck2.pos/

(You typically deliver this via QR code on the truck, so customers don’t type anything.)

What runs on the router?
Two things:

DNS (dnsmasq): make every truckX.pos resolve to 10.0.0.1
Example:

truck1.pos -> 10.0.0.1

truck2.pos -> 10.0.0.1

Reverse proxy (HAProxy or nginx): inspect hostname and choose the right backend pool:

truck1.pos → backends 10.0.0.2:8080, 10.0.0.3:8080

truck2.pos → backends 10.0.0.4:8080, 10.0.0.5:8080

Example HAProxy routing logic (conceptual)
If Host == truck1.pos → use backend “truck1”

If Host == truck2.pos → use backend “truck2”

Each backend has health checks so if .2 is down, .3 serves, etc.

This solves your .2/.3 and .4/.5 problem cleanly without needing anything on iPhones besides a browser.

Downside: you need a way to create/maintain the mapping “truckId → tablet IPs”. In practice this is easy because your POS app already knows the truckId; tablets can periodically “register” to the router via a simple UDP/HTTP ping, and the router updates proxy tables (or you preconfigure static pools if IPs are stable).

What you should pick
If you want maximum simplicity + isolation: Option 1 (SSID/VLAN per truck).

If you want one SSID and can accept a bit more router config: Option 2 (hostname-based routing).

One practical detail (important)
On iPhone, names like truck1.pos only work if the router’s DNS hands them out via DHCP. That’s normal for OpenWrt / GL.iNet.

Also, don’t rely on .local for iPhone unless you specifically want mDNS behavior; for router DNS, a custom domain like .pos or .lan is usually smoother.

If you tell me which direction you prefer:

Many SSIDs/VLANs, or

One SSID + truck1.pos / truck2.pos hostnames,

…I’ll give you the exact concrete config structure (dnsmasq + haproxy) and the simplest “tablet registration” approach that doesn’t require installing any extra apps.


only option2 is acceptabe

Thought for 4 seconds
Cool — Option 2 (single SSID, route by hostname) can work very well, and the mental model is:

All customers always hit the router (same IP)

The hostname (truck1.pos / truck2.pos / …) tells the router which cluster to forward to

The router does health-check + failover across that truck’s tablets

What URL does the client connect to?
They connect to a truck-specific hostname that resolves to the router:

Truck #1: http://truck1.pos/

Truck #2: http://truck2.pos/

…

Truck #30: http://truck30.pos/

Each truck prints a QR code that encodes its URL. Customer scans → browser opens it.

Behind the scenes all those hostnames resolve to the router IP (10.0.0.1), and the router routes based on hostname.

What runs on the router (exactly)?
You run two services:

1) DNS (dnsmasq) — “all truck names point to the router”
On OpenWrt/GL.iNet you can add DNS entries like:

truck1.pos -> 10.0.0.1

truck2.pos -> 10.0.0.1

…

truck30.pos -> 10.0.0.1

This ensures when a phone requests truck17.pos, it lands at the router.

Practical tip: use a domain like .pos or .lan. Avoid .local because iOS treats it specially for mDNS.

2) Reverse proxy / load balancer (HAProxy recommended)
HAProxy listens on router port 80 and forwards based on the HTTP Host header:

If host is truck1.pos → forward to one of truck1’s tablets (healthy one)

If host is truck2.pos → forward to one of truck2’s tablets

etc.

HAProxy also does health checks, so if tablet .2 dies, it automatically uses .3.

The one remaining problem: how does the router know which tablets belong to which truck?
You’ve got two choices:

A) Static mapping (simplest if you can control IPs)
You assign static DHCP leases so each tablet always gets the same IP, then you configure:

truck1 backend = 10.0.0.2:8080, 10.0.0.3:8080

truck2 backend = 10.0.0.4:8080, 10.0.0.5:8080

This is dead simple, but operationally annoying at 30 trucks unless you have a good provisioning flow.

B) Dynamic “tablet registration” (recommended)
Each tablet’s POS app already knows its truckId. So have the app periodically tell the router:

“I am truck17, I am alive, my web server is on port 8080.”

This is not an extra app — it’s a tiny feature inside your POS app.

Then the router maintains a live table:

truck17 → [10.0.0.42:8080, 10.0.0.57:8080, …] (only active ones)

Failover becomes automatic because the router always routes to an alive tablet.

How to implement registration (simple + robust):

Tablet sends an HTTP POST every 2–5 seconds to the router:

POST http://10.0.0.1:9000/register

body: { truckId, deviceId, port, secretProof }

Router marks it “alive” for, say, 15 seconds; if no refresh → remove it

To keep trucks isolated, registration includes truckSecret proof (HMAC), so a tablet from truck2 can’t claim it’s truck1.

What does HAProxy look like (conceptually)?
frontend on :80

ACL checks hostname:

hdr(host) -i truck17.pos

backend bk_truck17 has a dynamic server list (from registration) + health checks

On OpenWrt, HAProxy supports runtime updates via its admin socket; your router-side “registry” script can add/remove servers without restarting HAProxy.

Router requirements (what to buy/use)
Pick a router that can run OpenWrt packages reliably:

GL.iNet routers are usually great for this (they’re basically OpenWrt with UI)

You need enough CPU/RAM for HAProxy + dnsmasq + your small registry service (this is typically very light)

Customer experience
They join the shared Wi-Fi

They scan the truck’s QR

It opens http://truck17.pos/

Router forwards to a live tablet

If that tablet dies mid-session, worst case they refresh and they’ll land on another tablet

(If you want even smoother recovery, you can keep sessions stateless and design the web UI so refresh is harmless.)

One important iPhone caveat
Some iPhones will try https:// automatically if they’ve seen it before. Offline, you can either:

keep it as http:// only (recommended for v1), or

also serve a local TLS cert (extra complexity)

For v1: print QR codes with http://truck17.pos/ explicitly.

If you tell me what router family you’re leaning toward (GL.iNet model / generic OpenWrt box), I’ll give you a concrete minimal setup:

dnsmasq entries pattern for 30 trucks

HAProxy config skeleton for host-based routing

a tiny router “registry” service design (can be shell + uhttpd, Python, or Go) that updates HAProxy live based on tablet registrations.


ok, note that each tablet has unique cluster uuid and also a frindly cluster name(brand) , for example brasao, so ideally the QR code should point to brasao.helenabox.com which if internet is available will be redirected to a normal website associated for ordering , and if they are running on local wifi then it should go to the corresponding local server whatever the current master server is for the cluster

Thought for 12s
Yep — this is totally doable, and the clean way to get that behavior is split-horizon DNS + router TLS termination + hostname-based routing.

Goal recap
QR code always points to the same URL, e.g.

https://brasao.helenabox.com

And:

On normal internet: it goes to your cloud ordering site for Brasao.

On the local event Wi-Fi: it goes to the router, which forwards to a currently-alive tablet in the Brasao cluster (no single master).

The core trick: split-horizon DNS (same name, different answers)
You make brasao.helenabox.com resolve differently depending on where the phone is:

When NOT on your Wi-Fi (public internet)
Public DNS for brasao.helenabox.com → points to your cloud site (normal).

When ON your Wi-Fi (local LAN)
Your router acts as the DNS server (via DHCP), and it answers:

brasao.helenabox.com → 10.0.0.1 (router IP)

So the same URL in the QR “just works” and lands at the router locally.

Important: This doesn’t require the phone to “detect” anything. DNS decides.

Then the router does hostname routing to the right cluster
Router receives request for:

Host/SNI: brasao.helenabox.com

Router proxy (HAProxy/nginx) routes that hostname to the backend pool for Brasao’s cluster UUID, e.g.:

brasao.helenabox.com → one of [10.0.0.2:8080, 10.0.0.3:8080, ...] that are currently alive & registered for that cluster UUID.

So there’s no “master tablet” — the router just picks a healthy one.

HTTPS detail (this matters)
If your QR is https://brasao.helenabox.com, iPhones will expect a valid TLS certificate.

Best practice
Terminate TLS on the router using a cert for:

*.helenabox.com (wildcard) or individual certs per brand

Then proxy to tablets over plain HTTP on LAN.

This gives:

Valid HTTPS locally and on internet

No certificate warnings

Routing by SNI/Host works cleanly

Cert provisioning
Because the event might be offline:

You must pre-load the cert + key onto the router beforehand (don’t rely on renewals during the event).

Wildcard is easiest operationally.

How the router learns “which tablets are Brasao”
Use your earlier P2P discovery + add one small behavior in the POS app:

Each tablet periodically “registers” to the router:

clusterUuid

clusterName (e.g., brasao)

deviceId

port (8080)

auth (HMAC using cluster secret)

Router keeps an in-memory table:

brasao(clusterUuid=…) → live backends list

If a tablet stops checking in, it drops from the list automatically.

Router configuration summary (what you actually run)
On the router (OpenWrt/GL.iNet ideal):

DHCP hands out router as DNS

Local DNS override(s) (split-horizon):

brasao.helenabox.com -> 10.0.0.1

taco23.helenabox.com -> 10.0.0.1

etc (can be dynamic via your registry service)

Reverse proxy / load balancer

listens on 80/443

terminates TLS

routes by hostname to the right cluster backend pool

That’s it.

One real-world iPhone gotcha you should plan for
Some iPhones won’t use your Wi-Fi DNS if they’re doing iCloud Private Relay / DoH (or they may keep using cellular “helpfully”).

To make this reliable at events, you typically do one (or more) of these:

Provide Wi-Fi that doesn’t allow Private Relay (many captive-portal setups effectively do)

Block known DoH endpoints on the router (common event-network trick)

Strongly encourage “Wi-Fi only” (or at least ensure the Wi-Fi has internet too if possible)

Fallback safety net: also print a second tiny link/QR like:

http://10.0.0.1/brasao
or

http://brasao.pos
for the rare cases DNS behavior is stubborn.

What I recommend as your naming scheme
Use the friendly brand as a subdomain:

{brand}.helenabox.com (brasao.helenabox.com)

And maintain a mapping:

brand → clusterUuid → clusterSecret

So you can reassign “brasao” to a different cluster in the future without changing signage/QRs.

If you tell me your router target (OpenWrt? GL.iNet model?), I can give you a concrete implementation blueprint:

dnsmasq config approach (static vs dynamic host overrides)

HAProxy config style (SNI-based for HTTPS)

a tiny router “registry” service interface that tablets call (/register, /heartbeat, /deregister) and how it updates HAProxy live.


actually if we have a master tablet for each cluster then we can also make the main server for all the data update, we just need to make sure that any other tablet are in sync and can become master when needed, 

can you recoomend how exactly we will keep data on tablets

Yes — this is the right mental shift: per-cluster “leader” (master) for ingress + routing, but with automatic failover so any tablet can become leader and nobody loses data.

Below is a concrete recommended way to keep data on tablets that’s practical on Android/Fire, works offline, and supports “leader when available”.

1) Data model: every tablet stores the same two things
A) A real local DB (SQLite)
Each tablet keeps a full local copy so UI is fast and it can operate alone.

Tables (minimum):

orders (materialized current state used by UI)

oplog (append-only list of changes, for replication)

peers (known tablets + last seen)

sync_state (per-peer replication cursor / vector)

cluster_config (clusterUuid, brand, secret, myDeviceId)

SQLite is lightweight and reliable. You’re not “running a server”, you’re just storing a file.

B) An append-only operation log (the key to reliability)
Every user action becomes an immutable op record:

create order

add item

change status

mark paid

void

etc.

Why this matters:

replication becomes “send missing ops”

recovery is easy (replay ops to rebuild orders)

failover is safe because any tablet has the history

2) How writes work with a master, without losing offline capability
You want two modes:

Normal mode (leader available)
Client web traffic goes to the current leader tablet

Staff tablets also prefer sending writes to leader (optional)

Leader responsibilities:

accepts web orders (HTTP)

assigns “authoritative” order numbers (nice for receipts)

relays ops fast to others

Degraded mode (leader down / partition)
Any tablet can still take orders locally (staff UI)

It writes ops to its own oplog

When connectivity comes back, ops merge (eventual consistency)

So the leader is mainly for nice UX + stable ingress, not for correctness.

3) Leader election (how a tablet becomes “master”)
Within a cluster (3–10 tablets), you can do a simple, robust election:

Recommended: lease-based leader election
Every tablet has a deviceId and priority (optional)

Tablets gossip heartbeats

Whoever holds the current leader lease is leader for e.g. 5 seconds

Leader must renew lease continuously

If lease expires, others elect a new leader deterministically

Deterministic rule example:

choose highest priority, tie-break by lowest deviceId

This avoids split-brain most of the time; if Wi-Fi partitions, you can temporarily get two leaders, but the oplog design makes it survivable.

4) Replication: how tablets stay in sync
Use per-device counters (vector clock-ish) + pull/push ops
Each op includes:

deviceId (who created it)

seq (monotonic counter per device)

ts (timestamp for UX)

opId (deviceId:seq)

Each tablet tracks, per peer:

“highest seq I’ve seen from that device”

Sync between two peers is:

exchange summary {deviceId -> maxSeqSeen}

request missing ranges

send missing ops

apply ops idempotently (dedupe by opId)

This is extremely stable and easy to debug.

5) Conflict rules (so merges don’t get weird)
Design ops to be mostly commutative:

“add line item” is additive → no conflict

“status change / paid / void” are stateful:

define a clear precedence order

example: VOID wins over everything

PAID wins over SUBMITTED

use (logicalClock, deviceId) for last-write-wins for same field

Also: avoid “edit line item quantity” as a mutation; instead do:

ADD_ITEM sku qty

REMOVE_ITEM sku qty
This is much easier to merge correctly.

6) What exactly is stored on each tablet?
Minimal, concrete schema
orders (materialized)

orderId (ULID/UUID)

humanNumber (optional leader-assigned)

source (web/staff)

createdAt, updatedAt

status (NEW/SUBMITTED/PAID/VOID/etc.)

total, tax, etc.

customerName (optional)

order_items

orderId

lineId (ULID)

skuId

nameSnapshot

priceSnapshot

qty

oplog

opId (deviceId:seq)

deviceId

seq

ts

type

entityId (orderId)

payloadJson

applied (bool)

sync_state

peerId

lastSeen

knownVectorJson (deviceId->maxSeq)

This gives you fast UI + reliable replication.

7) How the router + “brand URL” works with a leader
Since you already want brasao.helenabox.com:

Router does split-horizon DNS → brasao.helenabox.com = 10.0.0.1

Router proxy forwards brasao.helenabox.com to the current leader tablet for Brasao

How router knows leader:

Tablets already do heartbeats/registration to router

The leader includes isLeader=true in heartbeat

Router forwards to that tablet

If leader disappears, next leader announces itself, router switches automatically

If you ever get split-brain (two leaders), router can pick “best” one by the same deterministic rule, and the system still converges later.

8) Practical recommendations (to keep this simple and safe)
Always log ops locally first (even leader). Never rely on “send then store”.

Idempotency everywhere: applying same op twice must be safe.

Snapshots for menu prices inside each order item (so price doesn’t change mid-day).

Periodic compaction: once orders are final, you can prune old ops or checkpoint.

Export path: daily export JSON/CSV from any tablet (since all have full data).

If you want the shortest “do this” recommendation
Store everything in SQLite on each tablet

Represent all changes as append-only ops in an oplog

Replicate ops with vector summary + pull missing

Use lease-based leader election for web ingress + order numbering

Router forwards brand.helenabox.com to whichever tablet currently claims the leader lease

If you answer one detail, I’ll lock the conflict model tightly:

Do you need editing an existing order from multiple staff tablets, or is it mostly create + add items + status/pay?


lets design generic backend layer that will be applied to pos and other projects, main requirement that it does run on android/fire tablets and ideally works on linux and routers as well, it should work with local network but support internet targets as well , the backedn layer will be called from web apps and react native apps , it will need to support some kind of DB semantics or obj storage but APIs should be simple rest APIs , ideally interface should be very simple generic, mostly amount of data will be very limited, probably less than 1MB, except maybe images. Most records are simple key value pairs, ideally support json and blobs ... sqlite sounds right especially if its a library and not a separate tool to install and its cross-platform, but even if we use sqllite the APIs should be different

Thought for 7s
Here’s a solid design for a generic “edge backend layer” you can reuse for POS and other projects, that:

runs embedded on Android/Fire tablets (inside a React Native app)

also runs as a standalone daemon on Linux/routers

works LAN-first but can also target internet endpoints

exposes simple REST APIs (JSON + blobs)

provides DB-ish semantics without exposing SQL

keeps data small (<1MB typically), with optional images/blobs

I’m going to describe it as a productized component so it’s easy to reason about and reuse.

1) What this thing is
Call it something like EdgeStore (name doesn’t matter).

It’s a small local service/library that provides:

Document/KV store (JSON records)

Blob store (images/files)

Change log (so devices can sync)

Optional clustering (peer discovery, replication, leader lease if you want)

Simple REST API used by:

React Native apps (staff tablets)

Web apps (customer browser via router proxy)

Other services (Linux/router tools)

Under the hood it uses SQLite + a couple tables for blobs/oplog.

Key principle: apps never talk SQL. They talk REST and get doc-store semantics.

2) Deployment shapes (same codebase)
You’ll use one of these two forms:

A) Embedded mode (Android/Fire / React Native)
EdgeStore runs inside your app as a local HTTP server bound to 127.0.0.1 (or 0.0.0.0 if you want LAN serving).

No separate install.

Data stored in app sandbox (/data/data/.../files/edgestore.db).

B) Daemon mode (Linux / router)
EdgeStore runs as a small service (systemd / init.d).

Stores edgestore.db on disk.

Exposes HTTP on LAN.

Same REST API in both.

3) Data model (simple but powerful)
Everything is scoped by a namespace (your cluster UUID / tenant / truck / project).

namespaceId (UUID) — hard isolation boundary

collection (string) — like orders, menu, settings

key (string) — record key

value (JSON) — record content

etag / version — optimistic concurrency

updatedAt, updatedBy

Blobs are stored separately and referenced by blobId.

4) Storage design (SQLite, but not SQL-shaped)
SQLite tables (conceptual):

docs
namespace TEXT

collection TEXT

key TEXT

json TEXT (or BLOB)

etag TEXT

updated_at INTEGER

deleted INTEGER

Primary key: (namespace, collection, key)

blobs
namespace TEXT

blob_id TEXT

content_type TEXT

bytes BLOB (or chunked)

sha256 TEXT

size INTEGER

oplog (for sync)
namespace TEXT

op_id TEXT (deviceId:seq or ULID)

device_id TEXT

seq INTEGER

ts INTEGER

op_type TEXT (PUT_DOC / DEL_DOC / PUT_BLOB / DEL_BLOB)

target TEXT (collection/key or blobId)

payload BLOB (compressed JSON delta or full doc)

peers / sync_state
Track what you’ve exchanged per peer (vector summary).

This gives you:

fast local reads

deterministic replication

crash-safe durability

simple compaction options

5) REST API (simple, generic, reusable)
5.1 Health / identity
GET /v1/health

GET /v1/node → { nodeId, deviceInfo, version }

5.2 Namespaces (tenants / clusters)
GET /v1/namespaces

POST /v1/namespaces → create {namespaceId, name, secret?}

GET /v1/namespaces/{ns}

In POS, namespaceId = clusterUuid, name = brand.

5.3 Documents (KV/JSON)
GET /v1/ns/{ns}/c/{collection}/k/{key}

PUT /v1/ns/{ns}/c/{collection}/k/{key} with JSON body
Headers:

If-Match: <etag> (optional optimistic lock)

DELETE /v1/ns/{ns}/c/{collection}/k/{key}

GET /v1/ns/{ns}/c/{collection}?prefix=abc&limit=200
(simple listing; you can add updatedSince)

Response includes:

etag

updatedAt

deleted (tombstone support)

5.4 Blobs (images/files)
POST /v1/ns/{ns}/blobs (multipart upload) → {blobId, sha256, size}

GET /v1/ns/{ns}/blobs/{blobId}

DELETE /v1/ns/{ns}/blobs/{blobId}

Optional:

GET /v1/ns/{ns}/blobs/{blobId}/meta

5.5 Changes feed (sync + “live updates” for apps)
This is the secret sauce that makes everything replicate and lets UIs subscribe.

GET /v1/ns/{ns}/changes?since=<cursor>&limit=500

Returns:

nextCursor

list of ops: {opId, type, target, ts, payloadHash}

Apps (RN/web) can:

poll every 1–2s, or

use GET /v1/ns/{ns}/changes/stream (SSE) for near real-time

6) Replication (LAN-first, internet-capable)
Replication is just exchanging oplogs.

Each node exposes:

POST /v1/ns/{ns}/replicate/pull

POST /v1/ns/{ns}/replicate/push

Simple anti-entropy protocol
A sends summary: { deviceId -> maxSeqSeen }

B responds with missing ops (paged)

A applies ops idempotently

This works on:

LAN direct tablet-to-tablet

router-to-tablet

internet (if you ever allow remote sync)

Conflict rules
Because API is “doc store”, you choose one of these per collection:

LWW (last-write-wins) for simple settings/config/docs

Append-only ops for things like orders (recommended)

instead of “replace order JSON”, you store orderEvents collection and materialize

Generic layer can support both by allowing a collectionMode:

doc-lww

event-log

7) “Leader / master” support (optional module, not required for correctness)
You can add a small API:

POST /v1/ns/{ns}/lease/acquire?name=leader

POST /v1/ns/{ns}/lease/renew?name=leader

POST /v1/ns/{ns}/lease/release?name=leader

GET /v1/ns/{ns}/lease?name=leader

Leader is just a time-limited lease stored locally + announced to peers (or to router registry).

POS uses leader for:

web ingress target

pretty order numbers

optional centralized payment integration

But any node can still write locally and sync later.

8) Discovery & router integration (so browsers “just work”)
You already picked hostname-based routing like:

brasao.helenabox.com

Make the router do:

split-horizon DNS: brasao.helenabox.com -> 10.0.0.1

reverse proxy routes Host=brasao.helenabox.com → current leader node for that namespace

To enable that, EdgeStore nodes do periodic registration to router:

POST http://10.0.0.1:9000/register

{ namespaceId, brand, nodeId, ip, port, isLeader, proof }

Router keeps a live table and updates HAProxy.

This keeps browsers simple (no app install) and keeps tablets replaceable.

9) Implementation recommendation (what to build it in)
You want Android + Linux/router with minimal pain.

Best practical choices:

Option A (recommended): Go core + SQLite + embedded HTTP
Cross-compiles easily for Linux/routers

Can be embedded into Android using:

a small native library + JNI, or

run as an in-app binary (some teams do this), or

use gomobile bindings (depends on how you want to package)

Very fast to build and debug

Option B: Rust core + SQLite + HTTP
Great performance/robustness

More engineering overhead than Go

Also cross-platform

(If you already have strong Kotlin expertise, Kotlin Multiplatform is possible too, but routers become annoying.)

10) What makes this “generic”
For POS, orders/menu are just:

ns/{clusterUuid}/c/orders/...

ns/{clusterUuid}/c/menu/...

blobs for images

For another project (say, equipment inventory), same API:

c/assets, c/locations, c/events, etc.

You don’t rewrite backend logic; you reuse EdgeStore + build your app logic on top.

11) One opinionated rule that will save you later
Even if records are “KV JSON”, treat important workflows as event logs, not mutable documents.

Example:

Instead of writing full order as one JSON doc repeatedly,

write orderEvents (append-only) and materialize orders.

Why:

sync is easier

conflicts are cleaner

audit/debug is built-in

EdgeStore can support both, but your POS should lean event-first.

If you want, I can write the exact minimal API contract as an OpenAPI spec
And/or propose a tiny “SDK” wrapper for:

React Native (TypeScript client)

Web (same TS client)

Router scripts (simple curl)

Just tell me whether you prefer the core implemented as Go or Rust, and whether on Android you’re ok with running a local HTTP server inside the app (that’s the simplest path).


I will implement the pos app using replit which prefers to use react native I beleive , Ideally the backend somehow should be embedded in that app so installation on tablet is just one app that includes  frontend app, backend and whatever else necessary , will it work ?

Yes — it can work as a single installable Android app that contains:

your React Native POS UI

an embedded “backend layer” (local DB + REST API + sync)

(optionally) a LAN-facing web server for customer ordering

The key is to decide how “embedded” the backend is. There are two viable patterns; both are used in real apps.

Option A (recommended): Backend is a JS/TS module, not a separate server
Instead of running a separate HTTP daemon inside the app, you implement the backend layer as a library that your RN code calls directly.

Inside the app you still expose REST, but it’s “virtual”:

RN screens call backend.putDoc(...), backend.list(...)

The customer web UI can still talk HTTP to the tablet (see below), but internally your app doesn’t need to loopback HTTP.

Storage

SQLite via RN (react-native-sqlite-storage or similar)

Blobs stored as files + metadata in SQLite (best)

Sync

RN opens sockets (HTTP/WS) to peers and exchanges oplog batches

Discovery via mDNS/NSD (native module) or UDP broadcast

✅ Pros

simplest packaging (one APK)

fewer moving parts

easiest on Fire tablets

great performance (no “server inside app” complexity)

⚠️ Cons

if you truly want external apps/devices to use the same REST API on the tablet, you still need an HTTP listener for them (but only for customer web, not for your own UI)

Option B: Backend runs as an in-app HTTP service (still one APK)
You run an actual local HTTP server inside the RN app process:

binds 127.0.0.1:PORT for internal calls, and/or 0.0.0.0:PORT for LAN

serves:

/api/... (docs/blobs/changes)

/web/... (customer ordering web app bundle)

This is doable in RN using:

an embedded HTTP server library (JS-based) or

a small native module that hosts a server

✅ Pros

“real REST API” exists

customer browsers can connect directly to a tablet if needed

same code path for internal + external requests

⚠️ Cons

more complexity (lifecycle, background restrictions, ports, power saving)

JS-thread server can struggle under heavy concurrent clients (dozens of phones)

Given you may have “lots and lots” of customer phones, I’d avoid making tablets handle all customer HTTP directly unless you have to.

The best combined approach for your requirement
You said earlier you’re okay using the router to solve “which tablet is alive” and failover. That’s perfect.

Recommended architecture (one APK per tablet)
Inside the tablet app:

React Native UI

SQLite-based backend module (Option A style)

a lightweight LAN API for sync + leader health (not customer traffic)

optional: a minimal HTTP endpoint for router health checks

On the router:

serves the customer web app + terminates TLS (brasao.helenabox.com)

forwards only order submit calls to the current leader tablet

(optional) caches menu locally or pulls it from leader

This keeps customer load off tablets as much as possible and makes the experience stable.

Will Replit + React Native support this?
Yes, but with one practical note:

Replit is fine for developing the RN app + TS backend module.

For discovery (mDNS/NSD) and some networking, you may need:

a small native module or an existing RN library.

SQLite is standard in RN and works fine on Android/Fire.

So “one app install” is realistic.

How the “embedded backend” should look (concrete)
Inside the RN app, implement a Backend service with this interface (no SQL exposed):

interface Backend {
  getDoc(ns: string, collection: string, key: string): Promise<Doc | null>;
  putDoc(ns: string, collection: string, key: string, value: any, opts?: { ifMatch?: string }): Promise<DocMeta>;
  delDoc(ns: string, collection: string, key: string): Promise<void>;
  list(ns: string, collection: string, opts?: { prefix?: string, limit?: number }): Promise<DocMeta[]>;

  putBlob(ns: string, bytes: Uint8Array, contentType: string): Promise<{ blobId: string }>;
  getBlob(ns: string, blobId: string): Promise<{ bytes: Uint8Array, contentType: string }>;

  appendOp(ns: string, op: Op): Promise<void>;
  changes(ns: string, sinceCursor: string): Promise<{ nextCursor: string, ops: Op[] }>;

  syncWithPeer(peerUrl: string, ns: string): Promise<void>;
}
Internally this uses:

SQLite for docs + oplog metadata

filesystem for blob bytes

oplog replication for sync

What about the customer web app?
You have 2 choices:

Choice 1 (recommended): Serve web app from router
Router hosts the static web bundle for brasao.helenabox.com

Tablet leader only handles:

POST /submitOrder

GET /menu (or router caches menu)

This scales best with “lots of iPhones”.

Choice 2: Serve web app from tablets
Possible, but:

you’ll need a robust in-app HTTP server (Option B)

you’ll need router proxy anyway for failover

concurrency might be rough on cheap tablets

Bottom line
✅ Yes, one APK can include everything (frontend + embedded backend + storage + sync).
The easiest + most reliable is:

backend as an in-app library using SQLite

router handles customer web + routing

tablets do sync + leader election + order processing

If you answer these 2, I’ll pin down the best “minimal moving parts” build plan:

Do you require the customer web UI to keep working if the router dies (rare), or is the router assumed reliable?

Rough peak customer traffic per truck: like 5–10 phones at once, or 50+?


1. for big events I should assume router is reliable , most likley I will come up with multiple internet sources like verizon + starlink and probably a few router / mesh as I will need to cover events with few thousands people (lets say 10K)
2. Most likely one food truck will only cover 100 phones at a time but its not that transaction heavy
3. I could implement backend separately from replit , I can use codex/visual code, but only if I later can integrate it whatever library I do with replit customer app, actually that would be preferred way of development, it also keeps separate backedn and frontend development, ideally backend library can be dynamically updated whena new version is available

Thought for 11s
Got it. With those assumptions (router reliable, up to ~100 phones/truck, not super write-heavy) the clean architecture is:

Router is the “web front door” + static web host + TLS + routing

Tablets are the replicated data/compute nodes

Backend is embedded in the tablet app (single APK install)

Backend is developed separately as a reusable library, and can be updated OTA (without reinstalling APK) if we keep most logic in the JS layer.

Below is the recommended design.

Recommended system layout for big events
Router (reliable)
Runs:

DNS override (split-horizon): brasao.helenabox.com -> 10.0.0.1

TLS termination + reverse proxy (HAProxy/nginx): routes Host=brasao.helenabox.com to the current leader tablet for that cluster

Serves the customer web app (static files): HTML/JS/CSS

Optional: menu cache so 100 phones don’t all hit tablets for menu

Tablets (3–10 per truck cluster)
Each tablet runs one Android app that contains:

RN staff POS UI

embedded backend library (DB + sync + “leader lease”)

a small HTTP API for the router to forward to (order submit, menu fetch, health)

No “extra apps” installed.

How we keep data on tablets (generic backend semantics)
Storage primitives (simple, generic)
Docs (JSON KV): namespace + collection + key -> JSON

Blobs: namespace + blobId -> bytes (images, etc.)

Oplog: append-only changes, for replication + audit

Under the hood:

SQLite for docs + oplog metadata

filesystem for blob bytes (better than storing big blobs in SQLite)

Replication (works with/without a leader)
Tablets replicate oplog entries (idempotent)

Any tablet can accept writes locally

When leader is up, it’s the preferred write/ingress target, but not required for correctness

Leader role (per cluster)
Router forwards customer orders to “leader”

Leader assigns pretty order numbers, coordinates pacing, etc.

If leader disappears, another tablet takes lease and router switches

This matches your “master but replaceable” idea.

The most important choice: how to embed the backend so it can be updated dynamically
You said you prefer backend separate dev and ideally OTA updates. That strongly favors this:

Backend = TypeScript library running inside RN JS runtime
Same code runs on:

Android RN app (embedded)

Router/Linux (as a service) if needed (Node or compiled variant)

Uses SQLite via RN bindings on Android

Exposes a REST interface from the app for router + web clients (but internally the app can call it directly)

Why this is best for OTA updates: you can update the backend logic via JS bundle update (e.g., CodePush-like OTA), without reinstalling the APK.

What stays “native” (rarely changes)
SQLite binding

mDNS/UDP discovery module (optional)

small HTTP server glue (optional)

Those rarely change; most logic (sync rules, schemas, endpoints) stays in TS and can be updated OTA.

If you implement the backend in Go/Rust native, dynamic updating inside an installed Android app becomes much harder (usually requires shipping a new APK). So JS/TS is the right default.

Clean separation of backend + frontend development (your preference)
Repo layout
edgelayer-core (TypeScript package)

storage layer (docs/blobs/oplog)

replication + leader lease logic

REST handlers (pure functions)

pos-tablet-app (React Native)

imports edgelayer-core

runs it locally using SQLite + filesystem adapters

exposes HTTP endpoints for router proxying

customer-web (web app)

static bundle hosted on router

talks to https://brasao.helenabox.com/api/...

You develop backend independently (VS Code/Codex), publish versioned package, and Replit app just consumes it.

Distribution
publish backend as a versioned npm package (private registry or Git tag)

the RN app pins versions for stability

OTA update strategy that actually works in the field
For tablets (Android/Fire)
Use two-tier updates:

Fast OTA (most changes): JS bundle update

updates backend logic + UI

signed bundle + staged rollout

can happen over LAN (router hosts the update) or internet

Rare update (native changes): APK update

only when you need new native modules / SQLite binding changes

Fire tablets can do managed sideload / MDM style deployment

This gives you “dynamic backend updates” without constantly touching APKs.

For router
keep router config stable (DNS + proxy + static hosting)

customer web bundle updates are just swapping static files (easy)

Scaling to thousands of people / 10k event
Per truck: 100 phones is fine if you do this:

Router serves static web (menu UI) locally (zero tablet load)

Only API calls hit tablets:

GET /menu (cacheable)

POST /orders (small JSON)

Router can optionally cache GET /menu for 30–60 seconds

So tablet load stays low even with many clients.

What I’d implement first (minimal viable backend layer)
SQLite doc store + blob store

Oplog + replication between tablets (vector summary + fetch missing)

Leader lease (time-based renewal)

Small REST surface:

GET /menu

POST /orders

GET /health

plus generic doc endpoints for reuse

Everything else can evolve.

One decision I’ll make for you (since you don’t want heavy APIs)
Keep the public REST extremely small and generic:

/v1/ns/{ns}/docs/{collection}/{key}

/v1/ns/{ns}/blobs/{blobId}

/v1/ns/{ns}/changes

/v1/ns/{ns}/orders (optional convenience wrapper for POS)

Internally you can have richer TS methods, but the network API stays stable.

If you want, next step I can produce (copy/paste ready):

The exact REST spec (OpenAPI) for the generic backend layer

The SQLite schema (docs/blobs/oplog/sync_state/leases)

The OTA update flow (how router hosts signed JS bundles; how tablets verify + apply)

Tell me one thing: do you want end-to-end encryption between tablets (per cluster secret) even on LAN, or is “trusted LAN + HMAC auth” enough for v1?


ok, lets define APIs and make few examples how it will be used

for example how menu items will be added/updated , how orders are added/updated, note that an order will go through different states , like pending, send for cooking etc, payment is also multi-step process ... so give me examples how it all be called from a client

Below is a generic, simple REST API that still handles your POS realities (menu updates, orders as state machines, multi-step payments) without exposing SQL. I’ll show:

Core API surface (generic)

Concrete POS conventions (collections + keys)

End-to-end examples from:

Admin/Staff RN app

Customer Web app

Kitchen display

Payment terminal flow

I’ll assume everything is scoped by namespace = clusterUuid (one truck/brand).

1) Core REST API (generic)
1.1 Documents (JSON)
Use “collection + key” with optimistic concurrency:

Get

GET /v1/ns/{ns}/c/{collection}/k/{key}

Upsert (create/update)

PUT /v1/ns/{ns}/c/{collection}/k/{key}

Headers:

If-Match: {etag} (optional; if present ensures no lost updates)

Body: JSON document

Response: {etag, updatedAt}

Delete (tombstone)

DELETE /v1/ns/{ns}/c/{collection}/k/{key}

Headers: If-Match optional

List

GET /v1/ns/{ns}/c/{collection}?prefix=&limit=&updatedSince=

1.2 Blobs (images)
POST /v1/ns/{ns}/blobs (multipart) → {blobId, sha256, size}

GET /v1/ns/{ns}/blobs/{blobId}

1.3 Changes feed (subscribe / poll)
GET /v1/ns/{ns}/changes?since={cursor}&limit=500
Returns ops like:

{ "nextCursor":"...", "ops":[{"type":"DOC_PUT","collection":"orders","key":"ord_...","ts":...}, ...] }
Web + RN can poll or use SSE: GET /v1/ns/{ns}/changes/stream

2) POS conventions on top of generic docs
Collections
menu_items — individual menu items

menu_sets — current menu version / availability

orders — materialized current order state

order_events — append-only event log per order (recommended)

payments — payment intents + status

terminals — payment terminal status/config (if needed)

settings — tax rates, tips, etc.

Key patterns
Menu item: mi_{sku} (e.g. mi_taco_asada)

Order: ord_{ULID}

Order event: ord_{ULID}:ev_{seq} (or ULID)

Payment: pay_{ULID}

3) Menu item create/update examples
3.1 Create a menu item (staff/admin app)
Request
PUT /v1/ns/{ns}/c/menu_items/k/mi_taco_asada

{
  "sku": "taco_asada",
  "name": "Asada Taco",
  "priceCents": 399,
  "currency": "USD",
  "taxCategory": "food",
  "isActive": true,
  "mods": [
    { "id": "extra_salsa", "name": "Extra salsa", "priceCents": 50 },
    { "id": "guac", "name": "Add guac", "priceCents": 150 }
  ],
  "image": { "blobId": "blob_01J...", "contentType": "image/jpeg" }
}
Response

{ "etag": "E-9f2c...", "updatedAt": 1762068123 }
3.2 Update price (with optimistic concurrency)
Get current:
GET /v1/ns/{ns}/c/menu_items/k/mi_taco_asada

Response includes etag: E-9f2c...

Update:
PUT /v1/ns/{ns}/c/menu_items/k/mi_taco_asada
Header: If-Match: E-9f2c...

{
  "sku": "taco_asada",
  "name": "Asada Taco",
  "priceCents": 449,
  "currency": "USD",
  "taxCategory": "food",
  "isActive": true,
  "mods": [...]
}
If someone else changed it first, you get 409 Conflict, and the app refetches.

3.3 Publish “today’s menu” snapshot
Why: customers must see a consistent menu version; also good for caching.

PUT /v1/ns/{ns}/c/menu_sets/k/current

{
  "menuVersion": "2026-03-01T10:00:00Z",
  "items": [
    { "sku": "taco_asada", "isAvailable": true },
    { "sku": "taco_pollo", "isAvailable": false }
  ],
  "updatedBy": "dev_tablet7"
}
Customer web app can just call:
GET /v1/ns/{ns}/c/menu_sets/k/current
and then fetch referenced menu items (or you can embed full item data if tiny).

4) Orders: create + state transitions (best pattern)
You said orders move through states (pending → sent to kitchen → cooking → ready → picked up), and updates can happen from different devices.

Recommendation: treat order changes as events, and keep a materialized orders doc for fast reads.

Order event types (examples)
ORDER_CREATED

ITEM_ADDED

ITEM_REMOVED

ORDER_SUBMITTED

KITCHEN_ACCEPTED

COOKING_STARTED

READY_FOR_PICKUP

ORDER_COMPLETED

ORDER_VOIDED

Your backend library applies events to compute orders[orderId].

4.1 Customer creates a cart/order (web app)
Client calls router URL (which forwards to leader tablet):
POST /v1/ns/{ns}/pos/orders

Body:

{
  "source": "customer_web",
  "customer": { "name": "Helen", "phone": "+1..." },
  "items": [
    { "sku": "taco_asada", "qty": 2, "mods": ["guac"] },
    { "sku": "soda_cola", "qty": 1 }
  ],
  "notes": "No onions please"
}
Server behavior

Generates orderId = ord_01J...

Writes an order_events record ORDER_CREATED

Writes/updates orders/ord_01J... materialized doc

Replicates via oplog to other tablets

Response

{
  "orderId": "ord_01JH8K...",
  "status": "PENDING",
  "humanNumber": 142,
  "estimatedMinutes": 12
}
This /pos/orders endpoint is a thin convenience wrapper. Internally it just writes docs/events using the generic API.

4.2 Kitchen display subscribes to changes
Kitchen display tablet (or web UI) polls:
GET /v1/ns/{ns}/changes?since=CURSOR123

Then fetches updated orders:
GET /v1/ns/{ns}/c/orders?kPrefix=ord_&updatedSince=... (or list endpoint)

Or simplest:

just GET /v1/ns/{ns}/c/orders?limit=200 every few seconds (small scale)

4.3 Kitchen transitions order to “COOKING”
Kitchen UI does an event append (generic API):

PUT /v1/ns/{ns}/c/order_events/k/ord_01JH8K...:ev_0007

{
  "orderId": "ord_01JH8K...",
  "type": "COOKING_STARTED",
  "ts": 1762068200,
  "by": { "role": "kitchen", "deviceId": "dev_kitchen1" }
}
Backend updates materialized orders/ord_... to:

status = COOKING

statusHistory += ...

updatedAt = now

All tablets sync the event and converge.

4.4 Ready for pickup
PUT /v1/ns/{ns}/c/order_events/k/ord_01JH8K...:ev_0008

{ "orderId":"ord_01JH8K...", "type":"READY_FOR_PICKUP", "ts":1762068288, "by":{...} }
5) Payments: multi-step flow examples
Payments usually behave like:

create payment intent

attempt authorization / capture

handle success/failure/cancel

optionally split tender, tip, partial captures, etc.

We’ll model payment as:

payments/pay_xxx doc (materialized)

payment_events optional (like orders) if you want full audit

5.1 Staff starts payment (POS tablet)
POST /v1/ns/{ns}/pos/payments

{
  "orderId": "ord_01JH8K...",
  "amountCents": 1247,
  "currency": "USD",
  "method": "card_present",
  "terminalId": "term_01",
  "tipMode": "prompt_on_terminal"
}
Response:

{
  "paymentId": "pay_01JH9A...",
  "status": "INITIATED"
}
Server writes:

payments/pay_... with state INITIATED

links it to order doc (e.g., orders[].paymentId)

5.2 Terminal handshake / awaiting tap
POS updates payment state:
PUT /v1/ns/{ns}/c/payment_events/k/pay_01JH9A...:ev_0002

{ "paymentId":"pay_01JH9A...", "type":"TERMINAL_REQUESTED", "ts":..., "terminalId":"term_01" }
Then:
... type:"AWAITING_CARD"

5.3 Approved
PUT /v1/ns/{ns}/c/payment_events/k/pay_01JH9A...:ev_0006

{
  "paymentId":"pay_01JH9A...",
  "type":"APPROVED",
  "ts":1762068400,
  "processorRef":"local_ref_abc123",
  "authCode":"A1B2C3",
  "capturedCents":1247
}
Backend materializes payments/pay_... to status=CAPTURED (or AUTHORIZED depending on your flow) and updates orders/ord_...:

order.status = PAID (or PAID_PENDING_FULFILLMENT, your choice)

order.payment = { paymentId, status, method }

5.4 Failure / retry
Event:

DECLINED with reason
Then POS can create a new payment intent or retry with same (depends on processor).

5.5 Partial / split tender (if you need it)
Payment doc can hold multiple “legs”:

legs: [{method, amountCents, status, ref...}, ...]
Still event-driven.

6) What the “client” code actually does (RN / Web)
6.1 Customer web app (browser)
Load menu:

GET https://brasao.helenabox.com/v1/ns/{ns}/c/menu_sets/k/current

GET .../c/menu_items?... as needed

Submit order:

POST https://brasao.helenabox.com/v1/ns/{ns}/pos/orders

That’s it.

6.2 Staff RN POS app
Mostly local calls (fast):

Directly call backend library functions (recommended)

Optionally also expose and use local HTTP for uniformity:

http://127.0.0.1:33445/...

Staff actions generate events:

ORDER_SUBMITTED

READY

VOID

etc.

6.3 Kitchen display
Subscribe changes feed

Render orders by status

Append events to move status forward

7) Why events + materialized docs is the sweet spot
Simple UI reads from orders collection

No complex merges: all replicas apply same ordered/idempotent events

Full audit trail

Works with leader or without

Next: pick the exact order/payment state machines
To make the examples precise, choose your v1 states:

Order states (suggested v1):

PENDING (created, not sent to kitchen)

SUBMITTED (sent)

COOKING

READY

COMPLETED

VOID

Payment states (suggested v1):

INITIATED

AWAITING_CUSTOMER

AUTHORIZED (optional)

CAPTURED

DECLINED

CANCELED

If you agree, I’ll produce:

a small OpenAPI spec for these endpoints

canonical JSON schemas for menu_item, order, order_event, payment, payment_event

and 6–8 full request/response sequences (customer order → kitchen → payment → completion) that you can directly implement.


I'm trying to understand in this example, is menu item stored as a js string in the database ?
what if I only want to update price and I don't have anything else , can I do it ?

Is the menu item stored as a JS string in the DB?
Conceptually it’s a JSON document. In SQLite you have a few implementation options:

Store the JSON as TEXT (a JSON string) in a column like docs.json_text

Or store as BLOB (compressed JSON)

Optionally also store indexed fields (sku, updatedAt, etc.) for fast filtering

So yes, the raw record is usually stored as a JSON string (TEXT) in SQLite, but you treat it as a JSON object at the API level.

Example SQLite row (conceptual):

namespace='...'

collection='menu_items'

key='mi_taco_asada'

json_text='{"sku":"taco_asada","name":"Asada Taco",...}'

etag='E-...'

Your app/API always reads/writes JSON objects; the “string” is just storage format.

Updating only the price (without sending the full object)
Yes — you can support that. There are two clean ways.

Option A (recommended): PATCH with JSON Patch (or Merge Patch)
Add a generic patch endpoint:

JSON Merge Patch (super simple)
PATCH /v1/ns/{ns}/c/{collection}/k/{key}

Header: If-Match: <etag> (recommended)

Body:

{ "priceCents": 449 }
Server behavior:

loads existing doc

merges fields (replaces only those provided)

writes back updated doc

emits an oplog entry

Response

{ "etag":"E-new...", "updatedAt": 1762069000 }
This is very easy for clients: “send only changed fields”.

Caveat: Merge Patch can’t delete a field cleanly unless you use null semantics, so decide: {"field": null} means delete or set null.

JSON Patch (RFC 6902) (more precise)
Body like:

[
  { "op": "replace", "path": "/priceCents", "value": 449 }
]
More expressive, slightly more work.

Option B: Model price changes as events (best for audit/history)
Instead of mutating the menu item directly, you append an event:

PUT /v1/ns/{ns}/c/menu_item_events/k/mi_taco_asada:ev_0012

{ "type":"PRICE_SET", "priceCents":449, "ts":..., "by":"dev_..." }
Then materialize menu_items/mi_taco_asada from events.

This is overkill for menu in many cases, but great if you want:

change history

easy rollback

“price effective at time X”

What I recommend for your POS
For menu updates: use PATCH Merge Patch (simple)

For orders/payments: use event log (because state machines + conflict rules)

So menu stays easy, orders stay robust.

Example: update only price safely
Get the doc to obtain etag:
GET /v1/ns/{ns}/c/menu_items/k/mi_taco_asada

Response:

{
  "etag": "E-9f2c",
  "doc": {
    "sku": "taco_asada",
    "name": "Asada Taco",
    "priceCents": 399,
    "isActive": true
  }
}
Patch only the price:
PATCH /v1/ns/{ns}/c/menu_items/k/mi_taco_asada
Header: If-Match: E-9f2c
Body:

{ "priceCents": 449 }
If someone else edited it first → 409 Conflict (client refetches and retries).

If you want, I can lock the exact semantics for PATCH:

do we treat "field": null as delete?

do we allow PATCH without If-Match (last-write-wins), or require it for admin changes like pricing?


ok, we also need to make sure that client side APIs are super simple , no REST API , just simple js api (that does call REST APIs if needed )

for example to update price should be something like
update_obj(table="menu",key="mi_taco_asada",value="{ 'priceCents':449}")


Perfect — we can make the client API a tiny JS SDK with exactly that simplicity, while the SDK internally chooses:

local direct calls (fast path in RN)

or HTTP REST (when running in browser / talking to router / talking to another node)

Design goals for the JS API
One-liners like update_obj(...)

Same calls work in:

React Native staff app (embedded backend)

Browser customer app (remote backend via router URL)

No need for the app developer to think about:

endpoints

etags

PATCH vs PUT

retries

leader routing

offline queueing

1) The minimal JS SDK surface
Core primitives (generic)
get_obj({ table, key }) => object | null

put_obj({ table, key, value }) => newObject  // full replace

update_obj({ table, key, value }) => newObject  // partial merge patch (your example)

del_obj({ table, key }) => void

list_obj({ table, prefix?, limit?, updatedSince? }) => [{key, obj, meta}]
Event primitives (for orders/payments)
append_event({ stream, id, event }) => void
get_state({ stream, id }) => object // materialized state, e.g. order
subscribe({ tables?:[], streams?:[] }, handler) => unsubscribe()
You can still expose orders.create(), orders.transition() as convenience wrappers, but the above is the generic base.

2) Your exact example: update price
You want:

update_obj({ table: "menu", key: "mi_taco_asada", value: { priceCents: 449 } })
What it does internally
If embedded (RN): updates SQLite doc + writes oplog entry

If remote (browser): sends an HTTP PATCH merge patch

Handles concurrency safely:

default: last-write-wins (simplest)

optional: strict mode uses etags automatically

3) Mapping “table” to backend collections
To keep your API “table=menu”, the SDK maps:

table: "menu" → collection menu_items

table: "orders" → collection orders (materialized)

stream: "order_events" → collection order_events (append-only)

So the caller uses human-friendly names.

4) Concrete SDK behavior rules (simple + predictable)
put_obj(...)
Full replace:

good for creating menu items/settings

uses PUT remote, or direct local write

update_obj(...)
Partial update:

merge patch

only the provided fields change

remote path uses PATCH with JSON merge patch

local path loads existing object, merges, writes new doc

Conflict handling
You have two modes (SDK option):

mode: "lww" (default)
No etag required, updates always succeed, last write wins.

mode: "safe"
SDK auto-fetches etag, uses If-Match, retries once if conflict.
(Better for admin price edits.)

You don’t expose this complexity to the app unless you want to.

5) Order examples using the same “simple JS API”
5.1 Customer submits an order (browser)
Expose one convenience function:

pos.create_order({
  items: [{ sku: "taco_asada", qty: 2, mods: ["guac"] }],
  notes: "No onions"
})
Internally SDK does:

append_event({ stream:"order_events", id: orderId, event:{type:"ORDER_CREATED", ...}})

backend materializes orders/{orderId}

Return:

{ orderId: "ord_...", humanNumber: 142, status: "PENDING" }
5.2 Kitchen marks cooking
append_event({
  stream: "order_events",
  id: "ord_01J...",
  event: { type: "COOKING_STARTED", ts: Date.now() }
})
Or a helper:

pos.set_order_status("ord_01J...", "COOKING")
(Helper just appends the right event.)

5.3 Payment multi-step
const pay = await pos.start_payment({ orderId, method: "card_present", terminalId: "term_01" })
// -> creates payment doc + event INITIATED

await pos.payment_event(pay.paymentId, { type: "AWAITING_CARD" })
await pos.payment_event(pay.paymentId, { type: "APPROVED", authCode: "...", capturedCents: 1247 })
Again, all events; materialized payment doc updates.

6) How the SDK decides “local vs remote”
SDK is created with a transport:

React Native staff app
const api = createClient({
  mode: "embedded",            // direct calls to backend library
  namespace: clusterUuid
})
Browser customer app
const api = createClient({
  mode: "remote",
  baseUrl: "https://brasao.helenabox.com",  // router split-DNS points local
  namespace: clusterUuidOrBrandResolved
})
Same method calls either way.

7) What REST exists (but hidden)
You still implement REST in the backend because:

browsers can only do HTTP(S)

router proxying is HTTP(S)

Linux/router integrations are easiest over HTTP

But your app developers never touch it directly.

8) Exact “update_obj” semantics (I propose this)
update_obj({table,key,value}) does:

Load current object (if exists, else {})

Deep-merge for objects (configurable: shallow vs deep)

Arrays: replace by default (simpler + deterministic)

Write back

Emit oplog entry for replication

Return the updated full object (and optionally meta).

Example return:

{
  obj: { sku:"taco_asada", name:"Asada Taco", priceCents:449, ... },
  meta: { etag:"E-...", updatedAt:... }
}
9) Quick usage examples (exactly like you asked)
Update price
await api.update_obj({
  table: "menu",
  key: "mi_taco_asada",
  value: { priceCents: 449 }
})
Mark an item unavailable
await api.update_obj({
  table: "menu",
  key: "mi_taco_asada",
  value: { isAvailable: false }
})
Create a new menu item
await api.put_obj({
  table: "menu",
  key: "mi_new_item",
  value: { sku:"new_item", name:"New Item", priceCents: 799, isActive:true }
})
Create order (customer)
const { orderId } = await api.pos.create_order({
  items: [{ sku:"taco_asada", qty:2 }],
  notes: ""
})
Move order state (kitchen)
await api.pos.transition(orderId, "COOKING_STARTED")
await api.pos.transition(orderId, "READY_FOR_PICKUP")
If you like this, next I’ll write the actual TypeScript SDK skeleton (interfaces + transport layer + embedded adapters + remote adapters) and the minimal backend REST endpoints it calls.


note that APIs should be generic , note pos related, so api.pos.create_order is a wrong example

note that I also need examples when I need to get multiple records based on some kind of filter , for example how would I get orders created yesterday from 1p to 2p

Got it — no POS-specific helpers. The SDK stays generic (tables/keys/docs/events), and POS logic is built on top in your app code using those generic calls.

Also: you want querying like “orders created yesterday 1–2pm”. With SQLite underneath, we can support filters, but we should keep the client API simple and portable.

Here’s the clean design:

1) Generic JS SDK API (simple)
// single objects
get_obj({ table, key })
put_obj({ table, key, value })          // full replace
update_obj({ table, key, value })       // merge patch
del_obj({ table, key })

// bulk
list_keys({ table, prefix?, limit?, cursor? })      // cheap listing
get_many({ table, keys })                           // batch fetch
query({ table, where, orderBy?, limit?, cursor? })  // filtered query

// optional: change feed
subscribe({ tables }, handler) => unsubscribe
Where:

table maps to a collection (e.g. "orders", "menu")

records are JSON objects

keys are strings ("ord_...", "mi_...")

2) How filtering works (generic + portable)
To support “created between time A and B”, we need one rule:

Rule: every record you want to query must include indexed fields
Example order doc includes:

{
  createdAt: 1762061000000,   // epoch ms
  updatedAt: 1762062000000,
  status: "COOKING",
  ...
}
Then query() can filter on those fields.

Query language (simple JSON)
We define a tiny set of operators that map well to SQLite and can also map to other stores later:

comparisons: $eq $ne $lt $lte $gt $gte

membership: $in

prefix: $prefix

boolean logic: $and $or

Example:

where: {
  $and: [
    { createdAt: { $gte: startMs } },
    { createdAt: { $lt: endMs } }
  ]
}
3) Examples (generic)
3.1 Update only price (your exact style)
await update_obj({
  table: "menu",
  key: "mi_taco_asada",
  value: { priceCents: 449 }
})
3.2 Create an order (generic)
(No api.pos.*; you just write to the orders table.)

const orderId = `ord_${ulid()}`

await put_obj({
  table: "orders",
  key: orderId,
  value: {
    orderId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "PENDING",
    items: [
      { sku: "taco_asada", qty: 2, mods: ["guac"] }
    ],
    notes: "No onions",
    source: "customer_web"
  }
})
3.3 Update order status (generic)
await update_obj({
  table: "orders",
  key: orderId,
  value: { status: "COOKING", updatedAt: Date.now() }
})
If you want auditable state transitions, you’d additionally write to a generic events table, but that’s still generic:
table:"events", key:"ord_xxx:ev_yyy", value:{entity:"orders", entityId:orderId, type:"COOKING_STARTED", ts:...}

4) Your query example: “orders created yesterday from 1pm to 2pm”
In the client you compute timestamps, then query.

Example code (generic SDK)
const startMs = Date.parse("2026-02-28T13:00:00-08:00")
const endMs   = Date.parse("2026-02-28T14:00:00-08:00")

const res = await query({
  table: "orders",
  where: {
    $and: [
      { createdAt: { $gte: startMs } },
      { createdAt: { $lt: endMs } }
    ]
  },
  orderBy: [{ field: "createdAt", dir: "asc" }],
  limit: 500
})

// res.items -> [{ key, obj, meta }, ...]
That’s the simplest possible “filter query” API while staying generic.

5) How this is implemented efficiently under the hood (still generic)
Because we’re using SQLite, we’ll maintain a small index table so queries don’t require scanning every JSON string.

Two ways:

Option A (recommended): declare indexed fields per table
When you initialize the backend:

define_table("orders", { indexes: ["createdAt", "status", "updatedAt"] })
define_table("menu",   { indexes: ["sku", "isActive"] })
The backend keeps an internal table like:

doc_index(namespace, table, key, field, num_value, text_value)

Then query() translates to SQL over the index table and returns matching keys, then batch fetches docs.

✅ fast and scalable
✅ still simple for clients
✅ portable query language

Option B: SQLite JSON1 queries directly on JSON
This is simpler to build but less consistent across environments and can be slower on low-power routers.

Given you care about routers + Android performance, Option A is safer.

6) REST hidden behind the SDK (browser case)
Browser calls:

await query({ table:"orders", where:{...} })
SDK sends:
POST /v1/ns/{ns}/query

{
  "table": "orders",
  "where": { "$and":[{"createdAt":{"$gte":...}},{"createdAt":{"$lt":...}}] },
  "orderBy":[{"field":"createdAt","dir":"asc"}],
  "limit": 500
}
But app dev never sees this.

7) One important note about “yesterday”
To avoid timezone bugs, store:

createdAt as epoch ms

and optionally createdLocalDate like "2026-02-28" if you want easy daily reporting.

But epoch ms alone is enough.

If you want, next I’ll lock the exact query operators supported (keep it small) and show 6 more examples:

orders by status

orders updated in last 5 minutes

menu items available = true

find by prefix

pagination with cursor

batch get by keys


few more requirements, I need to add  :

we should have some kind of security model , where they client need to authenticate with the server somehow (but make it super simple) so we know what access is possible, most likely should be done with tokens or similar

access is probably granular on table/column level , with no access/read or full access, access should be done for groups and users belong to groups


another requirement is that on certain servers (like internet,main servers) we will collect data potentially from 1000s of "clusters" so the backedn database will be post likely Postrgress or similar , but code ideally we need universal that work on andoird/linux and still support SqlLite/Postgress


another one is table management , each tablet may belong to a certain app, certain brand, location and have some type , for example : app=pos, brand=brasao, location=Miami1, type=Settings

Got it. Below is a generic design that adds:

Super-simple auth + RBAC (users, groups, table/field-level access)

Same JS SDK + same REST contract working with SQLite (edge) and Postgres (cloud/central) via interchangeable adapters

Device/tablet management as generic records (app/brand/location/type)

I’ll keep it practical and minimal—something you can actually implement.

1) Security model (simple but real)
1.1 Concepts
User: an identity (could be anonymous customer, staff, admin device)

Group/Role: RBAC container (e.g., customer, cashier, kitchen, manager, device)

Permissions: allow/deny by:

namespace (cluster)

table

action (read/write/delete/query)

optional fields restrictions (column/field allowlist)

1.2 “Super simple” authentication
Use Bearer tokens. Two token types:

A) Customer token (easy)
Obtained via QR / “join” flow, or issued automatically from router/captive portal

Scope: read menu, create orders, read own order status

Lifetime: short (e.g. 2–8 hours)

B) Staff/device token (secure)
Issued during setup (scan admin QR / enter PIN)

Scope: kitchen updates, payment, menu edits, exports

Lifetime: longer (days/weeks), can rotate

Header on every request (or SDK call):
Authorization: Bearer <token>

1.3 Token contents (JWT-ish but offline-friendly)
You can use either:

JWT signed by cluster secret (works offline, no DB lookup required)

or opaque token stored in tokens table (requires lookup)

For offline edge devices, JWT signed with the cluster secret is very convenient.

Token claims:

{
  "sub": "user_123",
  "groups": ["kitchen"],
  "ns": "clusterUuid",
  "exp": 1762072000,
  "scope": ["read:orders", "write:order_events"]
}
1.4 Authorization rules
Enforce in backend before any doc operation.

Actions:

read, write, delete, query, blob_read, blob_write, admin

Rule format (stored as JSON doc in acl_rules table):

{
  "ns": "clusterUuid",
  "group": "kitchen",
  "rules": [
    { "table": "orders", "allow": ["read", "query"], "fields": ["orderId","status","items","createdAt","humanNumber"] },
    { "table": "order_events", "allow": ["write","read","query"] }
  ]
}
Field/column level:

easiest: field allowlist on read

on write: allow only certain fields OR restrict to event tables for state transitions

For your POS: customers should never write orders.status directly. They can create an order, then only staff apps can append events / change status.

1.5 Groups + users
Users belong to groups:

users table (docs)

groups table (docs)

user_groups relationship (docs or join table)

But keep provisioning simple:

Staff login = PIN → backend issues staff token with groups

Customer = anonymous token limited scope

2) Universal DB layer: SQLite on edge, Postgres in cloud
2.1 Keep the contract the same
Your backend layer exposes the same logical operations regardless of DB:

get_obj / put_obj / update_obj / del_obj

query

blobs

changes feed (oplog)

auth / token issuance (optional endpoint)

device registration

2.2 Implement “drivers” / adapters
Backend core is DB-agnostic, with a storage adapter interface:

interface StorageAdapter {
  getDoc(ns, table, key): Doc | null
  putDoc(ns, table, key, doc, meta): DocMeta
  patchDoc(ns, table, key, patch, meta): DocMeta
  delDoc(ns, table, key, meta): void
  query(ns, table, querySpec): QueryResult
  putBlob(ns, blobId, bytes, contentType): BlobMeta
  getBlob(ns, blobId): Blob
  appendOp(ns, op): void
  readOps(ns, sinceCursor, limit): OpsPage
}
Then:

Edge adapter: SQLite + filesystem blobs

Cloud adapter: Postgres + object storage for blobs (S3/MinIO/etc.)

2.3 How “query” stays consistent
Use the query language we defined ($and, $gte, etc.) and implement it in both:

SQLite: use your doc_index table

Postgres: same doc_index table concept, but native and scalable

So both DBs have:

a docs table (jsonb in Postgres, text/json in SQLite)

an indexes table for queryable fields

In Postgres, docs.value should be JSONB for flexibility.

2.4 Multi-tenant at cloud scale (1000s of clusters)
Use namespace as a first-class column and always index it.

Postgres schema (conceptual):

docs(namespace, table, key, value_jsonb, etag, updated_at, deleted)

doc_index(namespace, table, key, field, num_val, text_val, bool_val, ts_val)

oplog(namespace, op_id, device_id, seq, ts, type, target_table, target_key, payload_jsonb)

blobs(namespace, blob_id, sha256, size, content_type, storage_ref)

Partition options later:

partition by namespace hash or by time for oplog

3) Tablet / node management requirements (app/brand/location/type)
Make this a generic table: nodes (or devices).

3.1 Device record
table="nodes", key="node_{nodeId}"

{
  "nodeId": "node_abc",
  "ns": "clusterUuid",
  "app": "pos",
  "brand": "brasao",
  "location": "Miami1",
  "type": "Settings",              // or "Cashier", "Kitchen", "Display", etc.
  "platform": "android",
  "model": "FireHD10",
  "ip": "10.0.0.23",
  "port": 33445,
  "lastSeenAt": 1762069000000,
  "isLeader": true,
  "capabilities": ["http_api", "sync", "printer"]
}
This supports:

router registration / discovery

fleet inventory

filtering “show me all kitchen tablets in Miami1”

debugging

3.2 How it’s written/updated
Tablet updates its node record every few seconds/minutes:

await update_obj({
  table: "nodes",
  key: `node_${nodeId}`,
  value: {
    ip: myIp,
    lastSeenAt: Date.now(),
    isLeader,
    location: "Miami1",
    type: "Kitchen"
  }
})
Access control:

only devices with group=device can write to nodes

4) Updated JS SDK (still super simple)
We keep your “one function” feel, but add auth context and namespace:

const api = createClient({
  baseUrl: "https://brasao.helenabox.com", // or embedded
  namespace: clusterUuid,
  token: myToken
})

// simple calls
await api.update_obj({ table:"menu", key:"mi_taco_asada", value:{ priceCents:449 } })

const orders = await api.query({
  table: "orders",
  where: { createdAt: { $gte: startMs, $lt: endMs } }
})
Token acquisition (simple)
You can keep token acquisition minimal and optional:

api.setToken(token) for staff

api.anonymous() for customer

Under the hood (browser):

POST /v1/auth/anonymous?brand=brasao returns a customer token
Or skip entirely if router injects token via cookie/header.

5) Query example (with auth) — “orders created yesterday 1–2pm”
const startMs = Date.parse("2026-02-28T13:00:00-08:00")
const endMs   = Date.parse("2026-02-28T14:00:00-08:00")

const res = await api.query({
  table: "orders",
  where: {
    $and: [
      { createdAt: { $gte: startMs } },
      { createdAt: { $lt: endMs } }
    ]
  },
  orderBy: [{ field: "createdAt", dir: "asc" }],
  limit: 500
})
RBAC ensures:

customers can’t query all orders

kitchen can query orders

managers can query + export

6) One critical constraint: “column-level” vs JSON docs
Since records are JSON, “column-level” really means field-level.
Implementation:

On reads: strip fields not allowed for that group

On writes: reject patches that touch forbidden fields (easy if you diff patch keys)

This is clean and enforceable.

7) What I need to lock down to finalize API spec
I won’t ask more than necessary, but two choices affect everything:

Do you want tokens to be JWT (stateless) or opaque (stored)?

For offline edge, I strongly recommend JWT signed per-cluster.

Do you want per-user identity for customers, or anonymous session tokens are enough?

For POS, usually anonymous session token is enough + order lookup by short code.

If you don’t answer, I’ll default to:

JWT tokens

anonymous customer sessions

If you want next: I’ll write the exact client SDK functions and the REST endpoints they map to, including:

login(pin) → token

anonymous() → token

query() → server-side indexed query

field-level filtering enforcement examples (customer vs kitchen vs manager).


JWT tokens

anonymous customer sessions

are acceptable

Thought for 4 seconds
Great — we’ll standardize on:

JWT bearer tokens

Anonymous customer sessions (JWT minted locally by the cluster/leader or router)

Below is a concrete, generic SDK API + the REST it hides, with realistic examples for menu, orders, status transitions, payments, and time-range queries — all without any pos.* helpers.

1) Client-side JS API (the only thing apps use)
Create a client
const api = createClient({
  namespace: "ns_clusterUuid",            // cluster UUID
  baseUrl: "https://brasao.helenabox.com" // browser (router split-DNS)
  // OR baseUrl: "http://127.0.0.1:33445" // embedded (RN app)
})
Auth (generic)
await api.auth.anonymous({ brand: "brasao" })      // customer session token
await api.auth.loginPin({ pin: "1234" })           // staff token (kitchen/manager/etc.)
api.auth.setToken(existingJwt)
Data (generic)
await api.put_obj({ table, key, value })
await api.update_obj({ table, key, value })        // merge patch
await api.get_obj({ table, key })
await api.del_obj({ table, key })

await api.query({ table, where, orderBy, limit, cursor })
await api.get_many({ table, keys })

await api.put_blob({ bytes, contentType })         // returns blobId
await api.get_blob({ blobId })
Events (generic append-only stream)
await api.append_event({ stream, id, event })      // stream = "events" usually
await api.query_events({ stream, id, since, limit })
table and stream are just strings. Your POS app decides conventions like "menu", "orders", "events".

2) JWT model (simple + offline)
JWT claims (example)
{
  "iss": "edgelayer",
  "ns": "ns_clusterUuid",
  "sub": "anon_01J...",          // or user_... for staff
  "groups": ["customer"],        // or ["kitchen"], ["manager"], ["device"]
  "scope": ["docs:read", "docs:write", "query"],  // optional
  "exp": 1762072000
}
Signing
Sign with cluster secret (HMAC-SHA256) on edge/leader/router.

Cloud servers can validate using the cluster’s secret (or rotate to asymmetric later).

3) Authorization model (RBAC, table + field level)
Stored as docs in a generic table, e.g. acl_rules:

table-level allow/deny: read/write/delete/query/blob_*

field allowlist on reads (and optionally on writes)

Example rule doc (generic):

{
  "key": "acl_default",
  "rules": [
    {
      "group": "customer",
      "tables": {
        "menu":  { "allow": ["read", "query"] },
        "orders": {
          "allow": ["write"], 
          "writeFields": ["items","notes","customer","source","createdAt"] 
        },
        "events": { "allow": ["write"], "writeFields": ["type","ts","entity","entityId","payload"] }
      }
    },
    {
      "group": "kitchen",
      "tables": {
        "orders": { "allow": ["read","query"] },
        "events": { "allow": ["write","read","query"] }
      }
    },
    {
      "group": "manager",
      "tables": { "*": { "allow": ["read","write","delete","query","blob_read","blob_write"] } }
    }
  ]
}
The backend enforces this. The SDK stays simple.

4) How data is stored (answering your earlier question)
Docs are stored as JSON (typically TEXT/JSONB). You treat them as objects.

Edge: SQLite stores JSON as TEXT (or BLOB), plus an index table for queryable fields

Cloud: Postgres stores JSON as JSONB, plus same index table pattern

You never expose SQL to clients.

5) Concrete examples (generic only)
5.1 Menu: create item, update price, query active items
Create menu item
await api.put_obj({
  table: "menu",
  key: "mi_taco_asada",
  value: {
    sku: "taco_asada",
    name: "Asada Taco",
    priceCents: 399,
    isActive: true,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
})
Update only price (your exact style)
await api.update_obj({
  table: "menu",
  key: "mi_taco_asada",
  value: { priceCents: 449, updatedAt: Date.now() }
})
Query menu items that are active
const res = await api.query({
  table: "menu",
  where: { isActive: { $eq: true } },
  orderBy: [{ field: "name", dir: "asc" }],
  limit: 200
})
5.2 Orders: create, update, state transitions via events
Customer creates an order (anonymous session)
await api.auth.anonymous({ brand: "brasao" })

const orderId = `ord_${ulid()}`

await api.put_obj({
  table: "orders",
  key: orderId,
  value: {
    orderId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "PENDING",
    items: [{ sku: "taco_asada", qty: 2, mods: ["guac"] }],
    notes: "No onions",
    source: "customer_web"
  }
})
If you want customers to be unable to directly set status, enforce via RBAC writeFields so they can only write a “create shape” and not change status later.

Kitchen moves order through states (event append)
Kitchen does not patch orders.status directly. It appends an event; the backend (or your app) materializes status.

await api.auth.loginPin({ pin: "4321" }) // returns JWT with group "kitchen"

await api.append_event({
  stream: "events",
  id: orderId, // the entity id for grouping
  event: {
    ts: Date.now(),
    entity: "orders",
    entityId: orderId,
    type: "COOKING_STARTED",
    payload: {}
  }
})
Backend behavior (generic policy module):

Applies event to orders/{orderId}:

status = "COOKING"

updatedAt = now

append to statusHistory (optional)

Mark READY
await api.append_event({
  stream: "events",
  id: orderId,
  event: {
    ts: Date.now(),
    entity: "orders",
    entityId: orderId,
    type: "READY_FOR_PICKUP",
    payload: {}
  }
})
5.3 Payments: multi-step (still generic)
Create a payment record
const payId = `pay_${ulid()}`

await api.put_obj({
  table: "payments",
  key: payId,
  value: {
    paymentId: payId,
    orderId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "INITIATED",
    amountCents: 1247,
    method: "card_present",
    terminalId: "term_01"
  }
})
Payment progresses via events
await api.append_event({
  stream: "events",
  id: payId,
  event: {
    ts: Date.now(),
    entity: "payments",
    entityId: payId,
    type: "AWAITING_CARD",
    payload: { terminalId: "term_01" }
  }
})

await api.append_event({
  stream: "events",
  id: payId,
  event: {
    ts: Date.now(),
    entity: "payments",
    entityId: payId,
    type: "APPROVED",
    payload: { authCode: "A1B2C3", capturedCents: 1247 }
  }
})
Backend materializes:

payments/{payId}.status = "CAPTURED"

optionally also updates orders/{orderId}.paymentStatus = "PAID"

RBAC example:

kitchen may read orders but not write payments

cashier may write payment events

6) Time-range query example: “orders created yesterday 1pm–2pm”
Client computes timestamps and calls query().

// America/Los_Angeles example: yesterday 1-2pm
const startMs = Date.parse("2026-03-02T13:00:00-08:00")
const endMs   = Date.parse("2026-03-02T14:00:00-08:00")

const res = await api.query({
  table: "orders",
  where: {
    $and: [
      { createdAt: { $gte: startMs } },
      { createdAt: { $lt: endMs } }
    ]
  },
  orderBy: [{ field: "createdAt", dir: "asc" }],
  limit: 500
})

for (const row of res.items) {
  console.log(row.key, row.obj.status, row.obj.createdAt)
}
Implementation note: for query() to be fast and portable (SQLite + Postgres), the backend maintains indexes for selected fields per table (createdAt, status, etc.).

7) What REST exists underneath (SDK hides it)
You won’t call these directly, but this is what the SDK maps to:

POST /v1/auth/anonymous → returns JWT (customer)

POST /v1/auth/pin → returns JWT (staff)

GET/PUT/PATCH/DELETE /v1/ns/{ns}/docs/{table}/{key}

POST /v1/ns/{ns}/query

POST /v1/ns/{ns}/events/append

POST/GET /v1/ns/{ns}/blobs

Same on SQLite edge and Postgres cloud.

8) Tablet management (your “app/brand/location/type” requirement)
Just another generic table: nodes

await api.update_obj({
  table: "nodes",
  key: `node_${nodeId}`,
  value: {
    nodeId,
    app: "pos",
    brand: "brasao",
    location: "Miami1",
    type: "Settings",
    lastSeenAt: Date.now(),
    ip: "10.0.0.23"
  }
})
If you want the next step: I can write the exact TypeScript types for query(where) and the minimal operator set (so it’s not a huge DSL), plus 5 more query examples (status in set, prefix search, updated in last N minutes, pagination cursor, and “my orders only” for anonymous customers).


if I keep all data in json then it will be difficult to search/filter, so I guess I will need to add some columns for filtering/search ... for example, I want to find orders that were made in certain time frame and done on certain equipment, so it means I need column for date/time and equipmentid , but I'm not sure if I need to keep it json as well or just separate "important" columns

You’re thinking about it exactly right: keep JSON for flexibility, but also maintain a small set of indexed fields as real columns (or a generic index table) so filtering is fast and portable across SQLite + Postgres.

There are two good patterns. For your “generic backend across many apps/tables”, the second is usually best.

Option 1: “Hybrid table per entity” (works, but not very generic)
For orders, you create a real SQL table with columns:

created_at

equipment_id

status

plus json for everything else

Example (conceptual):

orders(order_id PK, created_at, equipment_id, status, json)

✅ Fast, simple queries
❌ You must design SQL schema per table/entity (less generic)
❌ Harder to reuse across many projects without schema migrations

This is good if you only ever have a few entities and you’re okay writing migrations.

Option 2 (recommended): Keep docs as JSON + maintain a generic index table
You store the whole record as JSON, but also maintain index rows for selected fields.

Core idea
docs table holds the JSON

doc_index table holds “queryable fields” as typed columns

This keeps your backend universal: any “table” can declare which fields are indexed.

Schema (portable across SQLite + Postgres)
docs

namespace

table

key

json (TEXT in SQLite, JSONB in Postgres)

etag

updated_at

deleted

doc_index

namespace

table

key

field (e.g. "createdAt", "equipmentId")

num_val (for numbers / timestamps)

text_val (for strings)

bool_val

(optional) ts_val (or just use num_val for epoch ms)

Indexes:

(namespace, table, field, num_val)

(namespace, table, field, text_val)

plus (namespace, table, key) for joins

How indexing works
When you put_obj or update_obj:

write JSON doc

compute indexable fields for that table

replace index rows for that (ns, table, key)

You define per table:

define_table("orders", { indexes: ["createdAt", "equipmentId", "status"] })
Do you keep those fields in JSON too?
Yes — keep them in JSON as the source of truth, and also index them.

Why:

JSON remains the canonical record and is what replicates.

Index rows are a derived view used for query speed.

If index gets corrupted, you can rebuild it from JSON.

So for an order doc you’d still store:

{
  createdAt: 1762061000000,
  equipmentId: "eq_12",
  status: "DONE",
  ...
}
And the backend will additionally store index rows:

(createdAt, num_val=1762061000000)

(equipmentId, text_val="eq_12")

(status, text_val="DONE")

Example: query “orders in time frame AND equipmentId”
Client stays generic:

const res = await api.query({
  table: "orders",
  where: {
    $and: [
      { createdAt: { $gte: startMs } },
      { createdAt: { $lt: endMs } },
      { equipmentId: { $eq: "eq_12" } }
    ]
  },
  orderBy: [{ field: "createdAt", dir: "asc" }],
  limit: 500
})
Backend translates that to SQL over doc_index + fetches JSON docs by key.

What about “columns” vs “index table” performance?
For your scale (usually <1MB per cluster), either works. But the index-table approach wins because:

same logic works for SQLite and Postgres

you don’t need per-entity migrations

you can add/remove indexed fields without schema changes (just config)

One more refinement: multi-field queries without N joins
Naively, querying createdAt range AND equipmentId=... can require joining doc_index multiple times.

Better approach:

Store one row per field, but query using grouping:

Conceptually:

filter index rows matching each condition

group by (ns, table, key)

keep keys that match all required predicates

Implementation varies by DB, but it’s very doable and fast at your scale.

(If you want simplicity first, start with 2–3 joins; it’ll still be fine for small datasets.)

Recommendation for you
Use Option 2 universally:

JSON doc = canonical record

Index table = searchable fields

Per-table index config (small)

This gives you the “simple generic API” you want while supporting real filtering.

If you want, next I can pin down:

The exact define_table() config format (including field types)

The query(where) operator subset

A concrete SQL translation strategy that works identically on SQLite + Postgres (and stays fast)


ok, option2 is acceptable

Perfect. Here’s a crisp spec for Option 2 (JSON docs + generic index table), including:

schema (SQLite + Postgres friendly)

define_table() config

how put_obj/update_obj update indexes

query language + how it maps to index rows

examples (time range + equipmentId)

1) Storage schema (portable)
docs
Canonical JSON record (replicates, source of truth)

Columns

ns TEXT

table TEXT

key TEXT

json TEXT (SQLite) / JSONB (Postgres)

etag TEXT

updated_at BIGINT (epoch ms)

deleted BOOLEAN (or 0/1)

PK

(ns, table, key)

Index

(ns, table, updated_at) optional

doc_index
Derived searchable fields (rebuildable)

Columns

ns TEXT

table TEXT

key TEXT

field TEXT

Typed value columns (only one should be non-null per row):

num_val DOUBLE / BIGINT

text_val TEXT

bool_val BOOLEAN

bin_val BLOB (optional, usually skip)

json_val TEXT/JSONB (optional, avoid for v1)

PK

(ns, table, key, field) if you allow only one value per field
OR (ns, table, key, field, value_hash) if a field can be multi-valued

Indexes (critical)

(ns, table, field, num_val)

(ns, table, field, text_val)

(ns, table, field, bool_val)

(ns, table, key) (for joins)

2) Table definition API (generic, tiny)
You register which fields should be indexed and their type.

define_table("orders", {
  indexes: {
    createdAt:  { type: "number" },   // epoch ms
    equipmentId:{ type: "string" },
    status:     { type: "string" }
  }
})

define_table("menu", {
  indexes: {
    sku:      { type: "string" },
    isActive: { type: "bool" },
    name:     { type: "string" }
  }
})
Notes:

If a field is absent in a doc → no index row (or a null row; prefer “no row”).

If a field is multi-valued (e.g., tags), you can add:

{ type:"string", multi:true } → multiple rows in doc_index.

3) Write semantics (how indexes stay correct)
put_obj({table,key,value})
Write/replace the doc in docs with new etag, updated_at

Recompute index rows for configured indexed fields:

DELETE FROM doc_index WHERE ns=? AND table=? AND key=?

INSERT one row per indexed field found in JSON (or many if multi)

update_obj({table,key,value}) (merge patch)
Load existing doc JSON (or {})

Merge patch into doc

Same as put_obj from there (write doc + rebuild index rows)

Why “rebuild all index rows for that key” is fine:

your docs are tiny (<1MB total), and per doc indexes are only a handful of fields

simplest correctness story

easy to port

4) Query language (small set)
Client calls:

api.query({
  table: "orders",
  where: {
    $and: [
      { createdAt: { $gte: startMs } },
      { createdAt: { $lt: endMs } },
      { equipmentId: { $eq: "eq_12" } }
    ]
  },
  orderBy: [{ field: "createdAt", dir: "asc" }],
  limit: 500
})
Supported operators v1:

$eq

$in (list)

$gte, $gt, $lte, $lt

$prefix (string)

$and, $or

Constraints v1 (to keep it implementable fast):

comparisons apply to indexed fields only

one orderBy field must be indexed

5) How query maps to doc_index (implementation strategy)
Strategy: “candidate set intersection”
For each predicate, fetch matching keys, then intersect.

Example predicates:

createdAt >= startMs

createdAt < endMs

equipmentId == eq_12

Each predicate maps to a SQL query like:

For number range:

SELECT key FROM doc_index WHERE ns=? AND table=? AND field='createdAt' AND num_val >= ?

and another for < endMs (or combine with BETWEEN)

For string equality:

SELECT key FROM doc_index WHERE ... field='equipmentId' AND text_val = ?

Then:

intersect the returned key sets in memory (fast at your scale)

fetch docs by those keys from docs

This works identically in SQLite and Postgres, and is very easy to implement correctly.

Optimization later: do the intersection in SQL via joins/grouping. Not needed initially.

Fetch docs
SELECT key, json, etag, updated_at FROM docs WHERE ns=? AND table=? AND key IN (...) AND deleted=0

6) Examples you care about
Orders created yesterday 1–2pm and done on equipment eq_12
const startMs = Date.parse("2026-03-02T13:00:00-08:00")
const endMs   = Date.parse("2026-03-02T14:00:00-08:00")

const res = await api.query({
  table: "orders",
  where: {
    $and: [
      { createdAt: { $gte: startMs } },
      { createdAt: { $lt: endMs } },
      { equipmentId: { $eq: "eq_12" } }
    ]
  },
  orderBy: [{ field: "createdAt", dir: "asc" }],
  limit: 500
})
Menu items active and name prefix “Asa”
const res = await api.query({
  table: "menu",
  where: {
    $and: [
      { isActive: { $eq: true } },
      { name: { $prefix: "Asa" } }
    ]
  },
  orderBy: [{ field: "name", dir: "asc" }],
  limit: 200
})
7) Key design decision (I’ll set it for you)
Use “JSON is canonical; index is derived” always.

replicate only docs + oplog

each node rebuilds indexes locally when applying writes/ops

cloud can rebuild too

This keeps replication payload small and avoids index drift across nodes.

8) Next deliverable (what I can write next)
If you want, I’ll produce the final “contract pack” you can hand to Codex/Replit:

TypeScript types for:

QueryWhere, QueryOp, OrderBy, QueryResult

SDK function signatures + example usage

Backend REST endpoints that the SDK uses (still hidden from app dev)

SQLite + Postgres DDL for docs, doc_index, tokens, acl_rules, oplog

Tell me one preference and I’ll lock it in without further questions:

Do you want update_obj to deep-merge nested objects, or shallow merge only top-level fields?


ok, let's discuss backend for it again ,
summary : it runs on Fire Tablets, some routers(OpenWrt), linux servers.
it should be implemented in something that runs on android(FireTablet) or linux.
client library should be implemented for webapps(js) or android(react?)
it provides ability to save/update/delete/subscribe to different tables and data, 
where each table have 2 columns, the index column and value column , value could be a string (JSON) or blob(binary data). For binary data we have limited interface only add or delete. We can also add index to each table that dynamically built from JSON value . Table can be configured to have list of keys from JSON value that will be used to build the corresponding indexes.

the backend may keep its data in SQLLite database that is used as a library or in some cases PostrgresSql DB ( on some linux servers)

each device where we have the backend may be configured as replica or a leader or just a client. All together the form a cluster. There is only one leader in the cluster , which is elected between all devices. Only device that accessible from all replicas should be able to become a leader. A new leader can be elected if the original leader loosing connectivity.

Normally you have 2 or more clusters. Usually one cluster runs locally(offline) sometimes without internet connectivity and other cluster(s) runs in internet, usually each table has a cluster that serves as primary cluster and other clusters serve as secondary.  Primary means it has ultimate authority and primary storage target for the table. Primary and secondary tables may loose connectivity for some time as some clusters run offline. When merge data together primary has the final authority. 

All data updates happens only on leaders. Replicas get all the updates from the leader just to make sure they have up to date data. The read operations can be configured to be done from replicas instead of the leader.

We expect the sync between devices happens once every 100ms. So any update supposed to be completely in sync between all devices/clients within a single cluster in less than 500ms. 

We don't expect often updates for one database. Normally max up to 1000 updates a day. Normally offline cluster serve only one database. Online clusters normally serve many databases.

Each cluster can be configured not to keep data for longer than X hours ( normally 24h), but it should be kept in other clusters still. Note that the time filter only can be done on those tables that have such index.

Write me a spec for it.

API should include security access etc. 

API some kind like this : 

add_dbdrop_db(name)
add_table(name,type) // type json or binary
drop_table(name)

add_index(table_name,column_name,column_type)

get_objs(table_name,[ids],{filter},start_pos=0,max_count=-1)
add_objs(table_name,[ {},... ] )
update_objs(table_name,[ids], [{},...])
replace_objs(table_name,[ids], [{},...])
delete_objs(table_name,[ids])
subscribe_objs(table_name,{filter})

Thought for a few seconds
Below is a v1 specification for the backend you described. I’m keeping it generic (not POS), cross-platform (Fire/Android, OpenWrt, Linux), with SQLite/Postgres, leader/replica/client roles, JWT+RBAC, JSON+binary tables, dynamic indexes, filters, subscriptions, retention, and multi-cluster primary/secondary authority.

EdgeDB Layer v1 Spec
0. Goals and non-goals
Goals
Runs on:

Android / Fire tablets

Linux servers

OpenWrt routers

Provides a simple JS client API (SDK) for:

web apps (browser)

React Native apps (Android)

Backend provides:

CRUD on tables where each table is (id -> value)

value is either JSON doc or binary blob

query/filter using dynamically built indexes from JSON fields

subscribe to changes

security (JWT, groups, table/field permissions)

replication within a cluster (leader → replicas)

multi-cluster sync with primary authority for each table

retention (TTL by time index)

Non-goals (v1)
Complex distributed conflict resolution within a cluster (cluster is leader-authoritative)

Arbitrary SQL queries exposed to clients

Large-scale high-write workloads (your stated workload is low)

1. Architecture
1.1 Node roles
A node runs the backend and is configured as:

leader-eligible replica: participates in leader election and can become leader if reachable by all replicas

replica (non-eligible): receives updates from leader, can serve reads

client-only: no DB, no replication; uses SDK against leader/replicas

All nodes have a nodeId and belong to exactly one clusterId at a time.

1.2 Cluster
A cluster is a set of nodes (leader + replicas + clients). At any time:

Exactly one leader is active.

Leader is elected via lease-based election.

Only leader accepts writes.

Replicas receive updates from leader and can serve reads if enabled.

Leader eligibility constraint
Only nodes that are accessible from all replicas may be leader. This is enforced by:

Each replica maintains a connectivity list of reachable candidates.

Election chooses among candidates that pass “reachable-by-all” checks (details in §6).

1.3 Multi-cluster topology and table authority
You may have multiple clusters (e.g., offline_cluster + online_cluster).

Each table has:

a primary cluster (ultimate authority)

optional secondary clusters (replicate/cache)

Rules:

Writes happen only on leaders.

When connectivity is restored:

primary cluster wins if there is divergence between clusters.

secondaries must reconcile to primary.

For v1, treat non-primary clusters as read-through caches that may accept writes only if explicitly configured; otherwise they are read-only mirrors.

2. Data Model
2.1 Tables
A table is a logical collection of records:

table_name (string)

table_type: "json" or "binary"

Primary key: id (string)

Value:

JSON table: JSON object (stored as JSON text/JSONB)

Binary table: blob bytes + metadata (contentType, size, sha256)

2.2 Indexes (JSON tables)
Each JSON table can define index fields extracted from the JSON value.

Index definition: (field_name, field_type)

Types: string | number | bool | time

time stored as epoch ms (number) but treated as time in TTL logic.

Index is stored in a generic index store:

doc_index(table, id, field, num_val/text_val/bool_val)

Index rows are derived from JSON value; JSON remains canonical.

2.3 Retention / TTL
A table can define retention:

ttl_hours (integer)

ttl_field (index field name, must be time or number epoch-ms)

Retention is enforced by the leader:

periodic purge job (e.g., every 5 minutes)

purged rows become deleted records (tombstones) so replicas converge

secondaries may keep longer/shorter but must accept leader’s purge events

3. Storage Backends
3.1 Edge storage (SQLite)
SQLite file per database/namespace (or per cluster+db)

Tables:

docs (json)

blobs (binary metadata + optional chunking)

doc_index (derived indexes)

oplog (ordered writes for replication)

meta (schema/config)

acl / users / groups (optional local auth store)

Blobs:

Prefer filesystem storage + SQLite metadata on Android; routers/servers can use either.

3.2 Cloud/online storage (Postgres)
Same logical schema:

docs as JSONB

doc_index

oplog

blobs metadata; bytes stored in object storage (S3/MinIO) recommended

Supports many clusters/databases (multi-tenant keyed by dbId / namespace)

3.3 Universal behavior
Client SDK sees one uniform API, independent of SQLite/Postgres.

4. Namespaces / Databases
To support “many databases” on online clusters and usually “one database” offline, everything is scoped by:

dbId (string) — database identifier (maps to your cluster UUID / brand instance / tenant)

clusterId — which cluster the node belongs to

Most API calls are scoped: dbId, table.

5. Security
5.1 Auth: JWT Bearer tokens
All non-public endpoints require:
Authorization: Bearer <JWT>

JWT claims (minimum):

sub (user/session id)

dbId (authorized database)

groups (array)

exp (expiry)

optional: scopes

Signing:

Edge/offline: HMAC-SHA256 using dbSecret (per dbId)

Online: validate using stored dbSecret; later can move to asymmetric keys.

5.2 Anonymous customer sessions
Anonymous token minted by leader (or router front-end):

group: customer

short expiry (e.g., 2–12 hours)

scoped to one dbId

5.3 Authorization: RBAC + table + field permissions
Authorization check is performed on every operation.

Policy model:

Groups grant:

table permissions: read | write | delete | query | subscribe | blob_add | blob_delete | admin

optional readFields allowlist and writeFields allowlist for JSON docs

Example (conceptual):

customer: read/query menu, add new orders, read own order ids only

kitchen: read/query orders, write events/status fields

manager: full

Field enforcement:

On reads: strip fields not in allowlist.

On updates: reject patch if it touches fields outside allowlist.

6. Leader Election and Replication
6.1 Leader election (lease-based)
There is a logical lease: leaderLease(dbId)

Leader renews every T=200ms (config)

Lease timeout: 3T (e.g., 600ms)

If lease expires, new election occurs.

Leader eligibility rule
A node can be elected leader only if:

it is marked eligible=true

it is currently reachable by all replicas (connectivity quorum)

Reachability proof (v1 simple):

each replica reports its reachable leader candidates to the current leader (or in election gossip)

new leader must have “reachable-by-all” evidence within last N seconds (e.g., 3s)

6.2 Write path
Writes are accepted only on the leader for a dbId.

Leader assigns a monotonically increasing op_seq and appends to oplog.

Leader applies write to local storage (docs/blobs/index).

Leader streams oplog entries to replicas.

6.3 Replication frequency / latency targets
Replication tick: 100ms

Expected convergence within cluster: <500ms from leader commit

Mechanism:

leader maintains per-replica cursor (last acked op_seq)

pushes batches every tick

replicas ack after applying

6.4 Read path
Configurable per table:

read_policy = leader_only | replica_ok

SDK may also allow preferReplica=true and fall back to leader.

7. Multi-cluster synchronization (primary/secondary)
7.1 Table authority config
Each table has:

primaryClusterId

secondaryClusterIds[]

mode: mirror | cache | read_only_secondary | write_allowed_secondary (v2)

v1 recommended:

secondaries are read-only mirrors; only primary leader accepts writes for that table.

7.2 Sync protocol (cluster-to-cluster)
Leaders exchange oplog checkpoints for tables where they participate.

If secondary is offline, it replays missing oplog from primary when online.

If both accepted writes (not recommended v1), primary overwrites (authoritative) using last-write-wins by primary — but this implies data loss risk; keep it off in v1.

8. API Surface
Two layers:

Backend HTTP API (what SDK calls)

JS SDK API (what your app developers call)

You asked for API names like add_db, add_table, etc. Below is the logical API with both forms.

8.1 Backend HTTP API (v1)
All endpoints are scoped:

POST /v1/db/{dbId}/...

JWT required except where noted.

Database management
POST /v1/db {dbId, dbSecret?, config} → create

DELETE /v1/db/{dbId} → drop

GET /v1/db/{dbId}/meta → schema/config

Table management
POST /v1/db/{dbId}/tables {name, type} → add_table

DELETE /v1/db/{dbId}/tables/{name} → drop_table

GET /v1/db/{dbId}/tables → list tables

Index management
POST /v1/db/{dbId}/tables/{table}/indexes {field, type, multi?} → add_index

DELETE /v1/db/{dbId}/tables/{table}/indexes/{field}

JSON record ops
POST /v1/db/{dbId}/tables/{table}/get body: {ids?, filter?, start_pos?, max_count?}

POST /v1/db/{dbId}/tables/{table}/add body: {objs:[{id, value}...]} (leader only)

POST /v1/db/{dbId}/tables/{table}/update body: {objs:[{id, patch}...]} (merge patch, leader only)

POST /v1/db/{dbId}/tables/{table}/replace body: {objs:[{id, value}...]} (leader only)

POST /v1/db/{dbId}/tables/{table}/delete body: {ids:[...]}

POST /v1/db/{dbId}/tables/{table}/query body: {filter, orderBy?, start_pos?, max_count?}

Binary ops (limited interface)
POST /v1/db/{dbId}/tables/{table}/blob/add (multipart) → {id, sha256, size, contentType}

POST /v1/db/{dbId}/tables/{table}/blob/delete {ids:[...]}

GET /v1/db/{dbId}/tables/{table}/blob/{id}

Subscribe
POST /v1/db/{dbId}/tables/{table}/subscribe → SSE/WebSocket

body: {filter?}

server pushes events: added/updated/deleted with ids and optionally values

Auth (JWT)
POST /v1/auth/anonymous (no auth) {dbHint or brand} → returns JWT

POST /v1/auth/pin {dbId, pin} → returns JWT

POST /v1/auth/refresh {token} → new JWT (optional)

Cluster/leader info
GET /v1/db/{dbId}/cluster/status → leader, replicas, health

POST /v1/db/{dbId}/cluster/register (nodes heartbeat to leader or router)

(internal) /v1/db/{dbId}/replicate/push /replicate/pull

The replication endpoints are internal; SDK doesn’t call them.

8.2 Filter language (used in get/query/subscribe)
A minimal JSON filter spec:

$and, $or

$eq, $in

$gt/$gte/$lt/$lte

$prefix (strings)

Example:

{
  "$and": [
    {"createdAt": {"$gte": 1762061000000}},
    {"createdAt": {"$lt":  1762064600000}},
    {"equipmentId": {"$eq": "eq_12"}}
  ]
}
Filters are evaluated using doc_index. Non-indexed fields are not filterable in v1.

9. JS SDK API (what apps call)
You want something close to:

add_db(drop_db)
add_table(drop_table)
add_index(...)
get_objs(...)
add_objs(...)
update_objs(...)
replace_objs(...)
delete_objs(...)
subscribe_objs(...)
Here is the SDK spec.

9.1 SDK construction
const client = createClient({
  baseUrl,   // https://brasao.helenabox.com or http://127.0.0.1:33445
  dbId,
  token      // JWT
})
9.2 DB & table management
await client.add_db({ dbId, dbSecret?, config? })
await client.drop_db({ dbId })

await client.add_table({ name, type })     // type: "json" | "binary"
await client.drop_table({ name })

await client.add_index({ table_name, column_name, column_type, multi? })
9.3 Data operations
// Fetch by IDs and/or filter; pagination supported
await client.get_objs(table_name, ids=null, { filter=null, start_pos=0, max_count=-1 } = {})

// Add new (leader only)
await client.add_objs(table_name, [ { id, value }, ... ])

// Patch merge update (leader only)
await client.update_objs(table_name, ids, [ patchObj, ... ])

// Replace whole object (leader only)
await client.replace_objs(table_name, ids, [ fullObj, ... ])

// Delete (leader only)
await client.delete_objs(table_name, ids)

// Subscribe (SSE/WS); returns unsubscribe()
const unsub = await client.subscribe_objs(table_name, { filter }, (evt)=>{})
9.4 Binary ops
await client.add_blob(table_name, { id?, bytes, contentType })  // returns id if auto-generated
await client.delete_blobs(table_name, [ids])
await client.get_blob(table_name, id)
9.5 Auth helpers
await client.auth.anonymous({ brandOrDbHint }) // sets token internally
await client.auth.pin({ dbId, pin })
client.auth.setToken(jwt)
10. Example Flows
10.1 Configure a JSON table with indexes
await client.add_table({ name: "orders", type: "json" })
await client.add_index({ table_name: "orders", column_name: "createdAt",  column_type: "time" })
await client.add_index({ table_name: "orders", column_name: "equipmentId", column_type: "string" })
await client.add_index({ table_name: "orders", column_name: "status",     column_type: "string" })

// set retention: keep 24h based on createdAt
await client.update_objs("meta", ["table_orders_cfg"], [{
  ttl_hours: 24,
  ttl_field: "createdAt"
}])
10.2 Add an order (leader only)
await client.add_objs("orders", [{
  id: "ord_01J...",
  value: {
    createdAt: Date.now(),
    equipmentId: "eq_12",
    status: "PENDING",
    items: [{ sku:"x", qty:1 }]
  }
}])
10.3 Query orders in time range on equipment
const startMs = Date.parse("2026-03-02T13:00:00-08:00")
const endMs   = Date.parse("2026-03-02T14:00:00-08:00")

const res = await client.get_objs("orders", null, {
  filter: {
    $and: [
      { createdAt:  { $gte: startMs } },
      { createdAt:  { $lt:  endMs } },
      { equipmentId:{ $eq:  "eq_12" } }
    ]
  },
  start_pos: 0,
  max_count: 500
})
10.4 Subscribe to new/updated orders for one equipment
const unsub = await client.subscribe_objs("orders", {
  filter: { equipmentId: { $eq: "eq_12" } }
}, (evt) => {
  // evt: { type:"added|updated|deleted", table:"orders", id, value?, ts }
})
11. Operational requirements
11.1 Timing
Leader replication tick: 100ms

Replicas apply ops immediately and ack

End-to-end cluster convergence target: <500ms

11.2 Offline retention
TTL enforcement depends on indexed time field

If a table has no TTL index field, it cannot be TTL-purged by time

11.3 Limits
Expected: <=1000 updates/day/db

Default max payload sizes:

JSON record: 256KB (configurable)

Blob: configurable (e.g., 5–20MB)

12. Notes on “primary cluster authority”
To be explicit (v1 safest):

For tables where primaryClusterId != thisClusterId, the leader must reject writes with 403 ReadOnlyTable.

That guarantees no divergence; secondaries are always converging mirrors.

If later you want “write allowed on offline cluster then reconcile to primary”, that becomes a v2 feature requiring per-record conflict policy.

Next step
If you want, I can turn this spec into:

an OpenAPI document for the HTTP layer, and

a TypeScript SDK interface + type definitions (including Filter DSL), and

the SQLite + Postgres DDL for docs, doc_index, oplog, tables, indexes, acl, tokens.

Just say which deliverable you want first.


I see at least 2 issues : index for json string should be number - its faster
ttl should be 2 types, one that is actual ttl and another only propogated to one cluster, for example as an cook of POS I don't need access to orders from yesterday, but admin absolutely still need it, so we dont keep it locally but still keep data on server(online)

Good catches. Here’s how I’d fix the spec cleanly without breaking the “generic + universal” goal.

Fix 1: Index type for JSON strings should be numeric
Agreed — for performance and portability, indexes should prefer numeric comparisons whenever possible.

Updated index type system
Instead of “string/time/bool/number”, use:

i64 (integers; includes epoch ms)

f64 (optional; usually you can avoid)

str (only when you truly need text equality/prefix)

bool

So:

time fields are stored as i64 epoch ms

“enum-ish” fields (status) can be stored as numeric codes as well if you want max speed

IDs like equipmentId remain str unless you map them to integer IDs

How to make “strings numeric”
You have 3 options:

You store the numeric field directly in JSON

equipmentIdNum: 12 and index that (fastest, simplest)

Backend derives numeric from string via a mapping table

equipmentId "eq_12" → equipment_id_num=12

Hash-based numeric index

store hash64(equipmentId) as i64 for equality joins

(still keep original string in JSON)

Recommendation v1:

use createdAtMs as i64

keep equipmentId as string but optionally add equipmentIdHash (i64) for fast equality

Spec update
add_index(table, field, type) becomes:

type: "i64" | "str" | "bool" | "hash64"

and index storage columns become:

i64_val BIGINT

str_val TEXT

bool_val BOOLEAN

(Optionally hash64_val BIGINT but you can just treat it as i64.)

Fix 2: TTL must have two modes (hard TTL vs edge-retention)
You want:

Hard TTL / global delete (data truly expires everywhere)

Edge retention / local purge only (keep in online cluster, but drop from offline cluster)

That’s a very important distinction.

New terminology
Each table has Retention Policies per cluster:

Global TTL (authoritative deletion)

Data older than X is deleted at the primary cluster

Deletion is replicated to all clusters

Use for things that should expire everywhere (e.g., ephemeral sessions)

Local retention (cluster-specific)

Data older than X is not deleted globally

A cluster may prune locally for performance/storage

Online cluster (admin) keeps longer; offline/kitchen can keep short

When a node prunes locally, it must be able to “refetch” later if needed (or accept that it won’t have it)

How it works operationally
Primary cluster is still the source of truth.

Offline cluster may keep only last N hours locally.

Online cluster keeps full history (or much longer).

If offline cluster needs an old record later:

it can fetch from online when internet returns (optional feature)

or it simply won’t have it (acceptable for kitchen use cases)

Spec update: retention config
Add per table:

{
  "table": "orders",
  "timeIndexField": "createdAtMs",
  "globalTTL": { "enabled": false, "hours": 720 },
  "localRetention": [
    { "clusterId": "offline_miami1", "hours": 24 },
    { "clusterId": "online_main", "hours": 720 }
  ]
}
Rules:

globalTTL.enabled=true → primary leader emits tombstone deletes (replicated)

localRetention → each cluster leader runs a local prune job that deletes locally but does NOT emit tombstones

Important replication implication
Local pruning must not “fight” replication.

So:

Local prune deletes rows from local docs + local doc_index

But it must also store a prune watermark per table (e.g., “I pruned anything < T”)

If replication later tries to send older data:

cluster can discard it (if it still wants to keep it pruned)

OR accept it if policy changed

This avoids constant re-downloading.

Visibility / “kitchen doesn’t need yesterday”
This is actually two layers:

Authorization / policy (kitchen token can’t query yesterday)

Local retention (even if they had permissions, data isn’t stored locally)

You probably want both:

keep kitchen permissions limited

prune offline cluster aggressively

Updated API surface (minimal additions)
Index creation types
add_index(table_name, column_name, column_type) 
// column_type: i64 | str | bool | hash64
Table retention configuration (new)
set_table_retention(table_name, {
  time_field: "createdAtMs",
  global_ttl_hours: null | number,
  local_retention_hours_by_cluster: { [clusterId]: hours }
})
Or as doc updates via a meta table—either way.

Example: your “kitchen vs admin” requirement
Table: orders

Primary: online_main (keeps everything)

Secondary: offline_event_cluster (kitchen tablets)

Config:

globalTTL = null (don’t delete globally)

local retention:

offline cluster: 24h

online cluster: 30d (720h) or more

Now:

kitchen tablets physically store only last day

admin on online has full history

no global deletion happens, so history remains available.

One more improvement (optional but fits your model)
Add a read-through fetch capability:

If a replica doesn’t have an object (pruned), it can return “miss” and the SDK can optionally fetch from online cluster when reachable.

That keeps local storage small and allows occasional retrieval.

If you want, I’ll now produce the revised full spec with these two fixes fully integrated:

typed index columns (i64 preferred; hash64 supported)

dual retention model (global TTL vs local retention per cluster)

replication/prune watermark behavior so pruning doesn’t break sync


note one example, typically orders should be primary on offline cluster, as its the main location of orders, but for older orders that are out of retention it should get it from the online cluster, as local cluster will not have it,  authorization/policy is a different problem and we can discuss it separately

Got it. That implies a tiered authority model:

Offline cluster is primary for “hot” data (recent orders; accepts writes)

Online cluster is the long-term archive (keeps older history)

When offline prunes locally, it can read-through from online for older records

This is data placement/retention, not auth.

Here’s how to model that cleanly in the spec without introducing messy conflicts.

Spec update: Primary writes vs Archive reads
1) Separate two concepts per table
A) Write Authority (who is primary for writes)
writePrimaryClusterId: cluster whose leader is the authoritative writer for the table.

For orders:

writePrimaryClusterId = offline_cluster

B) Read Fallback / Archive Source (where to fetch when pruned)
readFallbackClusters: ordered list of clusters to query when local does not have a record (or does not have the requested time range).

For orders:

readFallbackClusters = [ online_cluster ]

This is different from “primary/secondary” in the old sense.

2) Retention becomes “local retention + archive replication”
For a table like orders:

Offline cluster keeps locally for localRetentionHours = 24

Online cluster keeps locally for localRetentionHours = 720 (or unlimited)

Offline leader replicates new writes to online cluster continuously (or opportunistically)

So online cluster becomes an append-only archive mirror.

Key rule to avoid conflicts
Online cluster is read-only for that table (no writes), so it never diverges.

Offline cluster is the only writer. Therefore:

no multi-writer conflict resolution needed (v1 stays simple).

3) Read-through behavior (when offline doesn’t have data)
We add explicit read modes to the API.

Read policies
readMode: "local_only" | "local_then_fallback" | "fallback_only"

Default:

replicas/clients use local_then_fallback for tables that declare fallback clusters.

What counts as “miss”
A miss occurs when:

GET(id) not found locally (either never existed or pruned)

QUERY(filter) time range is older than local retention watermark

or local table is configured to not keep that range

Response contract for misses
If local-only and not found:

return 404 NotFound

If local_then_fallback:

backend will attempt fallback clusters server-side or

SDK can do it client-side (simpler to implement first)

I recommend SDK-side first: easier and keeps backend smaller on routers.

4) Watermarks: making time-range queries efficient
Once you prune, you need to know what range you still have.

Per table, each cluster maintains:

localMinTimeMs (oldest kept)

localMaxTimeMs (newest kept; usually now)

This is updated by the prune job.

Example
Offline cluster orders table:

localMinTimeMs = now - 24h

If a query asks for yesterday 1–2pm and that’s older than localMinTimeMs, you know immediately:

local won’t have it → route to online fallback.

Updated configuration model
Table config (orders example)
{
  "table": "orders",
  "type": "json",
  "timeField": "createdAtMs",

  "writePrimaryClusterId": "cluster_offline_miami1",
  "readFallbackClusters": ["cluster_online_main"],

  "retention": {
    "cluster_offline_miami1": { "keepHours": 24, "pruneMode": "local_only" },
    "cluster_online_main":    { "keepHours": 720, "pruneMode": "local_only" }
  },

  "indexes": {
    "createdAtMs": { "type": "i64" },
    "equipmentId": { "type": "str" },
    "status":      { "type": "i64" }   // optional numeric status codes
  }
}
Notes:

pruneMode: "local_only" means do not emit global deletes.

Online keeps longer; offline keeps short.

API updates to support read-through
Keep your API shape, add one optional read_mode parameter.

get_objs
get_objs(table_name, [ids], { filter, start_pos, max_count, read_mode })
read_mode: local_only | local_then_fallback | fallback_only
subscribe_objs
Subscriptions are always local (by default), because fallback subscriptions would be confusing.
(If you ever want “subscribe to archived history”, that’s a different stream.)

Example flows
A) Normal order write (offline leader)
Client writes to offline leader:

await add_objs("orders", [{ id:"ord_...", value:{ createdAtMs: now, ... } }])
Offline leader replicates to its replicas (100ms ticks).

Offline leader also replicates to online cluster leader (WAN sync when available).

Online becomes the archive.

B) Read recent orders (offline cluster)
Query last 30 minutes:

served locally quickly.

await get_objs("orders", null, {
  filter: { createdAtMs: { $gte: now-30*60*1000 } },
  read_mode: "local_only"
})
C) Read old orders (fallback to online)
Query yesterday 1–2pm:

const res = await get_objs("orders", null, {
  filter: {
    $and: [
      { createdAtMs: { $gte: startMs } },
      { createdAtMs: { $lt: endMs } }
    ]
  },
  read_mode: "local_then_fallback"
})
Behavior:

offline leader/replica checks localMinTimeMs

sees query is older than retention

fetches from online cluster (or SDK does it)

Result returns from online, but to the caller it looks the same.

D) Get a specific old order by id
const ord = await get_objs("orders", ["ord_01J..."], {
  read_mode: "local_then_fallback"
})
If pruned locally, it fetches from online.

Replication rules (important)
To keep this simple and safe:

Orders table is single-writer (offline cluster leader).

Online cluster accepts incoming replication for orders but rejects local writes.

Offline cluster may be offline; replication resumes when connected.

Online cluster retention is longer, so it can answer historical queries.

This matches your stated “offline is primary but old data is on server”.

Implementation note: who performs fallback fetch?
Two options:

Option 1 (simplest to implement first): SDK does it
SDK tries local baseUrl first

If it gets 404 or MISS_OLDER_THAN_WATERMARK, it calls fallback baseUrl(s)

This keeps router/tablet backend smaller.

Option 2: backend does it
backend proxies to fallback cluster on miss

convenient, but adds complexity on edge devices

Given you’re targeting routers/tablets, I’d start with SDK fallback.

If you want, I’ll now rewrite the full spec section for:

“table authority model” (writePrimary + readFallback)

“retention + watermarks”

updated get_objs behavior and error codes (MISS_PRUNED, MISS_NOT_FOUND)
so it’s unambiguous for implementation.


ok , can you provide me pseudo code for backend API implementations , lets say for a leader, and limit only for DB / table APIs first , note that backend data access layer that provides access either to SqlLite or Postregress is a separate thing 

Below is leader-side pseudocode for the DB + table management APIs only (no CRUD yet), assuming:

There is a separate StorageAdapter (SQLite/Postgres) that you call.

Leader is authoritative for schema/config within its cluster.

Leader replicates schema changes to replicas via an internal Replicator (not detailed).

Auth/policy checks are stubbed as requireAdmin().

I’ll use a clean, implementation-oriented style (TypeScript-like pseudocode).

Core interfaces (assumed)
type DbId = string
type TableName = string

type TableType = "json" | "binary"
type IndexType = "i64" | "str" | "bool" | "hash64"

type TableConfig = {
  name: TableName
  type: TableType
  indexes: Record<string, { type: IndexType; multi?: boolean }>
  timeField?: string // e.g. "createdAtMs" for retention/watermark logic
  retention?: {
    // cluster-specific local retention; leader stores config, each cluster enforces locally
    keepHoursByCluster?: Record<string, number>
  }
  writePrimaryClusterId?: string
  readFallbackClusters?: string[]
}

type DbMeta = {
  dbId: DbId
  createdAtMs: number
  updatedAtMs: number
  // cluster config, secrets stored elsewhere
}
Storage adapter (already implemented elsewhere):

interface StorageAdapter {
  // DB-level
  dbExists(dbId: DbId): boolean
  createDb(dbId: DbId, meta: DbMeta): void
  dropDb(dbId: DbId): void
  getDbMeta(dbId: DbId): DbMeta | null
  setDbMeta(dbId: DbId, meta: DbMeta): void

  // Schema-level
  listTables(dbId: DbId): TableConfig[]
  getTable(dbId: DbId, table: TableName): TableConfig | null
  createTable(dbId: DbId, cfg: TableConfig): void
  dropTable(dbId: DbId, table: TableName): void
  updateTable(dbId: DbId, cfg: TableConfig): void

  // Index-level (schema)
  // (Could be part of updateTable; included here for convenience)
  ensureIndexSchema(dbId: DbId, table: TableName, field: string, idx: {type:IndexType; multi?:boolean}): void
  dropIndexSchema(dbId: DbId, table: TableName, field: string): void
}
Replicator (internal cluster replication channel for schema ops):

interface Replicator {
  broadcastSchemaOp(dbId: DbId, op: SchemaOp): void
}
Schema operations we replicate:

type SchemaOp =
  | { kind: "DB_CREATE"; dbId: DbId; meta: DbMeta }
  | { kind: "DB_DROP"; dbId: DbId }
  | { kind: "TABLE_CREATE"; dbId: DbId; table: TableConfig }
  | { kind: "TABLE_DROP"; dbId: DbId; tableName: TableName }
  | { kind: "TABLE_UPDATE"; dbId: DbId; table: TableConfig }
Leader API handler skeleton (DB + table management)
class LeaderApi {
  constructor(
    private store: StorageAdapter,
    private repl: Replicator,
    private clusterId: string,
  ) {}

  // ---- Auth helpers (stub) ----
  private requireLeader(ctx) {
    if (!ctx.isLeader) throw httpError(503, "NOT_LEADER")
  }
  private requireAdmin(ctx) {
    // verify JWT groups etc. (out of scope here)
    if (!ctx.userGroups.includes("admin")) throw httpError(403, "FORBIDDEN")
  }

  // ------------------------------
  // DB APIs
  // ------------------------------

  // add_db(name)
  public add_db(ctx, req: { dbId: DbId }) {
    this.requireLeader(ctx)
    this.requireAdmin(ctx)

    const dbId = normalizeDbId(req.dbId)
    if (this.store.dbExists(dbId)) {
      // idempotent create
      return { ok: true, dbId }
    }

    const now = nowMs()
    const meta: DbMeta = { dbId, createdAtMs: now, updatedAtMs: now }

    // Create DB and minimal metadata storage
    this.store.createDb(dbId, meta)

    // Optionally create system tables/config docs (meta tables)
    // e.g. "sys_tables", "sys_acl", etc. can be implicit in adapter.

    // Replicate schema op to replicas
    this.repl.broadcastSchemaOp(dbId, { kind: "DB_CREATE", dbId, meta })

    return { ok: true, dbId }
  }

  // drop_db(name)
  public drop_db(ctx, req: { dbId: DbId }) {
    this.requireLeader(ctx)
    this.requireAdmin(ctx)

    const dbId = normalizeDbId(req.dbId)
    if (!this.store.dbExists(dbId)) return { ok: true, dbId } // idempotent

    // Drop DB in storage
    this.store.dropDb(dbId)

    // Tell replicas to drop too
    this.repl.broadcastSchemaOp(dbId, { kind: "DB_DROP", dbId })

    return { ok: true, dbId }
  }

  // Optional helper: list DBs, get meta (not asked but common)
  public get_db_meta(ctx, req: { dbId: DbId }) {
    this.requireLeader(ctx) // or allow replica reads if you want
    this.requireAdmin(ctx)

    const meta = this.store.getDbMeta(req.dbId)
    if (!meta) throw httpError(404, "DB_NOT_FOUND")
    return meta
  }

  // ------------------------------
  // Table APIs
  // ------------------------------

  // add_table(name,type)
  public add_table(ctx, req: { dbId: DbId; name: TableName; type: TableType }) {
    this.requireLeader(ctx)
    this.requireAdmin(ctx)

    const dbId = normalizeDbId(req.dbId)
    ensureDbExists(this.store, dbId)

    const name = normalizeTableName(req.name)
    const type = req.type

    const existing = this.store.getTable(dbId, name)
    if (existing) {
      // idempotent; ensure type matches
      if (existing.type !== type) throw httpError(409, "TABLE_EXISTS_DIFFERENT_TYPE")
      return { ok: true, table: existing }
    }

    const cfg: TableConfig = {
      name,
      type,
      indexes: {},
      // defaults
      writePrimaryClusterId: this.clusterId,
      readFallbackClusters: [],
    }

    // Persist schema
    this.store.createTable(dbId, cfg)

    // Replicate
    this.repl.broadcastSchemaOp(dbId, { kind: "TABLE_CREATE", dbId, table: cfg })

    return { ok: true, table: cfg }
  }

  // drop_table(name)
  public drop_table(ctx, req: { dbId: DbId; name: TableName }) {
    this.requireLeader(ctx)
    this.requireAdmin(ctx)

    const dbId = normalizeDbId(req.dbId)
    ensureDbExists(this.store, dbId)

    const name = normalizeTableName(req.name)

    const existing = this.store.getTable(dbId, name)
    if (!existing) return { ok: true } // idempotent

    // Drop table schema + data (adapter decides how)
    this.store.dropTable(dbId, name)

    // Replicate
    this.repl.broadcastSchemaOp(dbId, { kind: "TABLE_DROP", dbId, tableName: name })

    return { ok: true }
  }

  // add_index(table_name,column_name,column_type)
  public add_index(ctx, req: {
    dbId: DbId
    table_name: TableName
    column_name: string
    column_type: IndexType
    multi?: boolean
  }) {
    this.requireLeader(ctx)
    this.requireAdmin(ctx)

    const dbId = normalizeDbId(req.dbId)
    ensureDbExists(this.store, dbId)

    const tableName = normalizeTableName(req.table_name)
    const field = normalizeFieldName(req.column_name)
    const idxType = req.column_type
    const multi = !!req.multi

    const cfg = this.store.getTable(dbId, tableName)
    if (!cfg) throw httpError(404, "TABLE_NOT_FOUND")
    if (cfg.type !== "json") throw httpError(400, "INDEX_ONLY_ALLOWED_ON_JSON_TABLES")

    // Idempotent add (but prevent type changes)
    const existing = cfg.indexes[field]
    if (existing) {
      if (existing.type !== idxType || !!existing.multi !== multi) {
        throw httpError(409, "INDEX_EXISTS_DIFFERENT_TYPE")
      }
      return { ok: true, table: cfg }
    }

    // Update schema config
    const newCfg: TableConfig = deepClone(cfg)
    newCfg.indexes[field] = { type: idxType, multi }

    // Persist schema change
    this.store.ensureIndexSchema(dbId, tableName, field, { type: idxType, multi })
    this.store.updateTable(dbId, newCfg)

    // Replicate full table config (simplest)
    this.repl.broadcastSchemaOp(dbId, { kind: "TABLE_UPDATE", dbId, table: newCfg })

    return { ok: true, table: newCfg }
  }

  // Optional: drop_index
  public drop_index(ctx, req: { dbId: DbId; table_name: TableName; column_name: string }) {
    this.requireLeader(ctx)
    this.requireAdmin(ctx)

    const dbId = normalizeDbId(req.dbId)
    ensureDbExists(this.store, dbId)

    const tableName = normalizeTableName(req.table_name)
    const field = normalizeFieldName(req.column_name)

    const cfg = this.store.getTable(dbId, tableName)
    if (!cfg) throw httpError(404, "TABLE_NOT_FOUND")
    if (!cfg.indexes[field]) return { ok: true } // idempotent

    const newCfg: TableConfig = deepClone(cfg)
    delete newCfg.indexes[field]

    this.store.dropIndexSchema(dbId, tableName, field)
    this.store.updateTable(dbId, newCfg)

    this.repl.broadcastSchemaOp(dbId, { kind: "TABLE_UPDATE", dbId, table: newCfg })
    return { ok: true, table: newCfg }
  }

  // Optional: set table authority/retention fields in a generic way
  public update_table_config(ctx, req: { dbId: DbId; table_name: TableName; patch: Partial<TableConfig> }) {
    this.requireLeader(ctx)
    this.requireAdmin(ctx)

    const dbId = normalizeDbId(req.dbId)
    ensureDbExists(this.store, dbId)

    const tableName = normalizeTableName(req.table_name)
    const cfg = this.store.getTable(dbId, tableName)
    if (!cfg) throw httpError(404, "TABLE_NOT_FOUND")

    // Only allow patching safe config fields here
    const newCfg = applyTableConfigPatch(cfg, req.patch)

    this.store.updateTable(dbId, newCfg)
    this.repl.broadcastSchemaOp(dbId, { kind: "TABLE_UPDATE", dbId, table: newCfg })

    return { ok: true, table: newCfg }
  }
}
Internal helpers (pseudocode)
function ensureDbExists(store: StorageAdapter, dbId: DbId) {
  if (!store.dbExists(dbId)) throw httpError(404, "DB_NOT_FOUND")
}

function normalizeDbId(x: string): string {
  // lowercase, trim, restrict chars
  return x.trim()
}

function normalizeTableName(x: string): string {
  // allow [a-z0-9_], etc
  return x.trim()
}

function normalizeFieldName(x: string): string {
  return x.trim()
}

function nowMs(): number { return Date.now() }

function httpError(code: number, msg: string) {
  return { code, msg } // placeholder
}

function deepClone<T>(x: T): T { return JSON.parse(JSON.stringify(x)) }

function applyTableConfigPatch(cfg: TableConfig, patch: Partial<TableConfig>): TableConfig {
  const out = deepClone(cfg)

  // Whitelist patchable fields
  if (patch.timeField !== undefined) out.timeField = patch.timeField
  if (patch.retention !== undefined) out.retention = patch.retention
  if (patch.writePrimaryClusterId !== undefined) out.writePrimaryClusterId = patch.writePrimaryClusterId
  if (patch.readFallbackClusters !== undefined) out.readFallbackClusters = patch.readFallbackClusters

  // indexes changes must go through add_index/drop_index to enforce rules
  if ((patch as any).indexes) throw httpError(400, "INDEXES_MUST_USE_ADD_INDEX_API")

  return out
}
Notes (so you don’t get surprised later)
1) Idempotency
All schema operations are designed to be idempotent:

add_db if exists → ok

add_table if exists same type → ok

add_index if exists same spec → ok

This matters because replication may replay schema ops.

2) Replication format
I used broadcastSchemaOp(dbId, SchemaOp) where TABLE_UPDATE sends full TableConfig. That’s simplest and avoids “patch ordering” issues.

3) Leader-only writes for schema
Schema changes should be leader-only because they impact replication and query/index behavior.

If you want next, I can add pseudocode for data APIs (get/add/update/replace/delete/subscribe) in the same style, including:

leader-only writes + replica read option

building/updating doc_index

query(filter) using index table

retention pruning + watermark updates


ok, now give me pseudo code for backend APIs for reading data such as get_objs and subscribe

Thought for 4 seconds
Below is leader-side pseudocode for read APIs only:

get_objs(table_name, ids, {filter, start_pos, max_count, read_mode})

subscribe_objs(table_name, {filter, read_mode}, onEvent) (SSE/WS style)

Assumptions:

StorageAdapter is separate and already provides low-level access (SQLite/Postgres).

Leader maintains (or can read) table config, indexes, and retention watermarks.

Auth/policy enforcement is stubbed with authorizeRead()/authorizeQuery() and field filtering is omitted unless noted.

Fallback to online cluster is optional; I’ll show both patterns:

(A) Return MISS_PRUNED / MISS_NOT_FOUND so SDK does fallback (simplest)

(B) Leader performs fallback fetch if configured (more complex)

Supporting interfaces (assumed)
type ReadMode = "local_only" | "local_then_fallback" | "fallback_only"

type GetOpts = {
  filter?: Filter | null
  start_pos?: number
  max_count?: number // -1 means no limit
  read_mode?: ReadMode
}

type Filter =
  | { $and: Filter[] }
  | { $or: Filter[] }
  | { [field: string]: { $eq?: any; $in?: any[]; $gte?: any; $gt?: any; $lte?: any; $lt?: any; $prefix?: string } }

type ObjRow = { id: string; value?: any; meta?: any; miss?: "NOT_FOUND" | "PRUNED" }

interface StorageAdapter {
  // schema
  getTableConfig(dbId, table): TableConfig | null

  // docs
  getDocsByIds(dbId, table, ids: string[]): Map<string, { json: any; meta: any }>
  getDocsByIdsPaged(dbId, table, ids: string[], start: number, limit: number): ObjRow[]

  // index query => returns list of ids (ordered optionally)
  queryIndex(dbId, table, filter: Filter, orderBy?: {field:string;dir:"asc"|"desc"}[], start?: number, limit?: number): string[]

  // watermarks for local retention
  getTableWatermark(dbId, table): { localMinTimeMs?: number; localMaxTimeMs?: number } | null
}

interface ClusterRouter {
  // optional backend-side fallback fetch to other clusters
  fetchFromCluster(clusterId: string, req: any): Promise<any>
}

interface ChangeBus {
  // leader publishes changes here on writes; subscribers attach here
  subscribe(dbId: string, table: string, handler: (evt: ChangeEvent) => void): () => void
}

type ChangeEvent = {
  ts: number
  type: "added" | "updated" | "deleted"
  table: string
  id: string
  // include value optionally (tradeoff bandwidth vs extra fetch)
  value?: any
}
1) Leader read API: get_objs
Key behaviors
If ids provided: fetch those docs.

If filter provided: use index query to get matching ids, then fetch docs.

Pagination uses start_pos/max_count (applies to the result-set ids).

read_mode:

local_only: never fallback; return misses with miss

local_then_fallback: either (A) return MISS_PRUNED so SDK can fallback, or (B) backend calls fallback clusters

fallback_only: skip local (used by SDK when it already decided to query archive)

Optional optimization
If table has timeField + watermark, detect that the query is fully older than local retention and short-circuit.

Pseudocode
class LeaderReadApi {
  constructor(
    private store: StorageAdapter,
    private changeBus: ChangeBus,
    private clusterId: string,
    private router?: ClusterRouter, // only needed if doing backend-side fallback
  ) {}

  private requireLeader(ctx) { if (!ctx.isLeader) throw httpError(503, "NOT_LEADER") }

  private authorizeRead(ctx, dbId, table) { /* JWT+RBAC */ }
  private authorizeQuery(ctx, dbId, table) { /* JWT+RBAC */ }

  // Detect if a filter is entirely older than watermark (best-effort).
  // Returns: "local_ok" | "definitely_pruned" | "unknown"
  private classifyByWatermark(dbId, tableCfg, filter): "local_ok" | "definitely_pruned" | "unknown" {
    if (!filter || !tableCfg.timeField) return "unknown"
    const wm = this.store.getTableWatermark(dbId, tableCfg.name)
    if (!wm?.localMinTimeMs) return "unknown"

    // Try to extract a time range constraint from filter on timeField
    const range = extractRange(filter, tableCfg.timeField) // {gte?, gt?, lt?, lte?} or null
    if (!range) return "unknown"

    // If upper bound <= localMinTimeMs -> definitely pruned
    const upper = range.lt ?? range.lte
    if (upper !== undefined && upper <= wm.localMinTimeMs) return "definitely_pruned"

    // Otherwise could be partially local or newer; treat as local_ok/unknown
    return "local_ok"
  }

  // get_objs(table_name, [ids], {filter}, start_pos=0, max_count=-1)
  public async get_objs(ctx, req: { dbId: string; table_name: string; ids?: string[] | null; opts?: GetOpts }) {
    this.requireLeader(ctx)

    const dbId = req.dbId
    const table = req.table_name
    const ids = req.ids ?? null
    const opts = req.opts ?? {}

    const start = opts.start_pos ?? 0
    const limit = opts.max_count ?? -1
    const readMode: ReadMode = opts.read_mode ?? "local_only"
    const filter = opts.filter ?? null

    const tableCfg = this.store.getTableConfig(dbId, table)
    if (!tableCfg) throw httpError(404, "TABLE_NOT_FOUND")

    // auth
    if (filter) this.authorizeQuery(ctx, dbId, table)
    else this.authorizeRead(ctx, dbId, table)

    // If caller asked fallback_only, do not touch local
    if (readMode === "fallback_only") {
      return await this.get_objs_from_fallback(ctx, req) // optional; or return error if not supported
    }

    // If filter indicates definitely outside local retention, signal pruned (SDK fallback)
    if (filter && readMode !== "local_only") {
      const cls = this.classifyByWatermark(dbId, tableCfg, filter)
      if (cls === "definitely_pruned") {
        // (A) simplest: return a structured miss reason so SDK goes to online
        return {
          ok: true,
          source: "local",
          miss: "PRUNED_BY_RETENTION",
          watermark: this.store.getTableWatermark(dbId, table),
          items: [],
          next_pos: start
        }
        // (B) alternatively, backend does fallback here:
        // return await this.get_objs_from_fallback(ctx, req)
      }
    }

    // 1) Determine target IDs
    let targetIds: string[] = []
    if (ids && ids.length > 0) {
      targetIds = ids
    } else if (filter) {
      // Use index query to find IDs. Pagination can be applied here or after.
      // Prefer applying pagination here to avoid returning huge id lists.
      targetIds = this.store.queryIndex(dbId, table, filter, /*orderBy*/ undefined, start, limit === -1 ? undefined : limit)
    } else {
      // No ids, no filter: define semantics (common choices)
      // - return error
      // - or return first N by updated_at
      // For v1, require ids or filter:
      throw httpError(400, "MUST_PROVIDE_IDS_OR_FILTER")
    }

    // If IDs path and pagination requested, apply it deterministically
    if (ids && ids.length > 0) {
      const sliced = paginateArray(targetIds, start, limit)
      targetIds = sliced.items
    }

    // 2) Fetch docs
    // Use adapter method that returns rows for each id, including misses if not present.
    const rows = this.store.getDocsByIdsPaged(dbId, table, targetIds, 0, -1)

    // 3) Mark misses and (optionally) decide about fallback
    // If readMode local_only: return rows with miss markers.
    // If local_then_fallback: either return miss markers OR resolve them via fallback.
    if (readMode === "local_then_fallback" && tableCfg.readFallbackClusters?.length) {
      // (A) simplest: return misses with type so SDK can fetch online
      // also include watermark to let SDK short-circuit next time
      return {
        ok: true,
        source: "local",
        watermark: this.store.getTableWatermark(dbId, table),
        items: rows,
        next_pos: computeNextPos(ids, filter, start, limit, rows.length)
      }

      // (B) backend-side fallback resolution (optional):
      // const resolved = await this.resolveMissesViaFallback(ctx, dbId, tableCfg, rows, req)
      // return { ok:true, source:"local+fallback", items: resolved, ... }
    }

    // 4) Return result
    return {
      ok: true,
      source: "local",
      watermark: this.store.getTableWatermark(dbId, table),
      items: rows,
      next_pos: computeNextPos(ids, filter, start, limit, rows.length)
    }
  }

  // Optional: backend-side fallback
  private async get_objs_from_fallback(ctx, req) {
    // If you choose SDK-side fallback only, just:
    throw httpError(501, "FALLBACK_ONLY_NOT_SUPPORTED_BY_BACKEND")
  }
}
Helper: extractRange (best-effort)
function extractRange(filter: Filter, field: string): {gte?:number;gt?:number;lt?:number;lte?:number} | null {
  // Minimal implementation:
  // - search for occurrences of { [field]: { $gte/$gt/$lt/$lte } } within $and trees.
  // - if multiple, combine conservatively.
  // If too complex, return null.
  const out: any = {}
  const nodes = flattenAndClauses(filter) // returns list of simple predicate objects
  for (const n of nodes) {
    const pred = (n as any)[field]
    if (!pred) continue
    if (pred.$gte !== undefined) out.gte = max(out.gte, pred.$gte)
    if (pred.$gt  !== undefined) out.gt  = max(out.gt, pred.$gt)
    if (pred.$lt  !== undefined) out.lt  = min(out.lt, pred.$lt)
    if (pred.$lte !== undefined) out.lte = min(out.lte, pred.$lte)
  }
  return Object.keys(out).length ? out : null
}
2) Leader subscribe API: subscribe_objs
Key behaviors
Subscription is local (cluster-local), because leader is source of writes.

Client provides filter to limit events.

Leader can choose to push:

IDs only (lighter) → client fetches objects

or IDs + value (heavier) → no extra fetch

Given your low update rate, either is fine; I’d default to IDs + minimal meta and optionally include value.

Pseudocode (SSE style)
class LeaderSubscribeApi {
  constructor(private store: StorageAdapter, private changeBus: ChangeBus) {}

  private requireLeader(ctx) { if (!ctx.isLeader) throw httpError(503, "NOT_LEADER") }
  private authorizeSubscribe(ctx, dbId, table) { /* JWT+RBAC */ }

  // subscribe_objs(table_name,{filter})
  public async subscribe_objs(ctx, req: {
    dbId: string
    table_name: string
    filter?: Filter | null
    include_values?: boolean
  }, sse: SseConnection) {
    this.requireLeader(ctx)

    const dbId = req.dbId
    const table = req.table_name
    const filter = req.filter ?? null
    const includeValues = !!req.include_values

    const tableCfg = this.store.getTableConfig(dbId, table)
    if (!tableCfg) throw httpError(404, "TABLE_NOT_FOUND")

    this.authorizeSubscribe(ctx, dbId, table)

    // Compile filter into a predicate that can be evaluated cheaply.
    // v1: filter evaluation uses index query on-demand (slower) OR a simple predicate on event payload.
    // Best approach: precompute "fast match" constraints (e.g. equality on indexed fields)
    const match = compileEventMatcher(filter)

    // Send initial hello + watermark (helps SDK decide about fallback for old ranges)
    sse.send({ type: "hello", dbId, table, watermark: this.store.getTableWatermark(dbId, table) })

    // Subscribe to leader's change bus
    const unsubscribe = this.changeBus.subscribe(dbId, table, (evt) => {
      if (!match(evt)) return

      if (!includeValues) {
        sse.send({ type: "change", ts: evt.ts, op: evt.type, table, id: evt.id })
        return
      }

      // If include_values, fetch doc (careful: can race with deletes)
      if (evt.type === "deleted") {
        sse.send({ type: "change", ts: evt.ts, op: "deleted", table, id: evt.id })
        return
      }

      const docMap = this.store.getDocsByIds(dbId, table, [evt.id])
      const doc = docMap.get(evt.id)
      sse.send({
        type: "change",
        ts: evt.ts,
        op: evt.type,
        table,
        id: evt.id,
        value: doc?.json ?? null,
        meta: doc?.meta ?? null
      })
    })

    // Handle disconnect
    sse.onClose(() => unsubscribe())

    // Keepalive (optional)
    sse.startHeartbeat(15000)

    return { ok: true }
  }
}
Filter matching for subscriptions
For subscriptions, you generally want fast matching, not running a SQL query per event.

A practical v1 approach:

support only “simple” subscription filters efficiently:

equality on indexed fields (e.g. equipmentId == "eq_12")

status in set

for complex filters, either:

accept and do a slower path (query index occasionally), or

reject with 400 FILTER_TOO_COMPLEX_FOR_SUBSCRIBE (acceptable v1)

Pseudocode:

function compileEventMatcher(filter: Filter | null): (evt: ChangeEvent) => boolean {
  if (!filter) return () => true

  // v1 simplification: only support AND of equality predicates for subscribe fast-path
  const eqs = extractEqualityPredicates(filter) // e.g. { equipmentId:"eq_12" }
  if (!eqs) {
    // either return conservative matcher (always true) or reject earlier
    return () => true
  }

  // If events include minimal indexed fields in payload/meta, you can match without fetching.
  // If not, you can only match by ID/table, or you must fetch the doc to test.
  return (evt) => {
    // If no payload to test, just let it through (client can refilter after fetching)
    return true
  }
}
If you want “server does filter strictly”, then either:

include indexed fields in the change event emitted by leader (best), or

fetch doc and evaluate filter (more expensive but your update rate is low).

3) Return shapes (recommended)
get_objs response
{
  ok: true,
  source: "local",                      // or "local+fallback" if you implement it
  watermark: { localMinTimeMs, localMaxTimeMs },
  items: [
    { id: "ord_1", value: {...}, meta: {...} },
    { id: "ord_2", miss: "PRUNED" },
    { id: "ord_3", miss: "NOT_FOUND" }
  ],
  next_pos: 500
}
subscribe events (SSE)
{ type:"hello", watermark:{...} }
{ type:"change", op:"added", table:"orders", id:"ord_1", ts:... }
{ type:"change", op:"updated", table:"orders", id:"ord_2", ts:..., value:{...} } // optional
If you want, next I can give pseudocode for:

leader write APIs (add_objs/update/replace/delete) including index rebuild and changeBus publish

queryIndex() implementation strategy using doc_index (including AND intersection and pagination)

watermark/prune job that updates localMinTimeMs correctly without generating tombstones (local-only retention)


ok, just to make sure thats clarify how updates are made, I probably see it that all updated should be done as a change log to make sure its easy replicatable and relatively easy to resolve potential conflicts  when meging primary and secondary . Tell if if its the approach you taking

for filters Ideally it should be really quick, as initial filter will be applied to data on disk but going forward we should ideally apply filtering in memory even before it actually saved in the database. We can simplify filters to make it easier

the most complex filter is see something like this :   (obj[key1]<datetime1) and (obj[key1]>datetime2) and (obj[key2] is one of [value1,value2,value3]). so only AND operation between conditions and <,<=,>,>=,!=,one_of,substring  (or find better names for it)

Yes — the approach I’m taking is change-log (oplog) first, with a materialized view for fast reads. That’s exactly what makes replication (leader→replicas and offline→online) simple, and it’s also what gives you a clean story for “primary vs secondary merge” later.

1) Updates as change log: what I’m proposing
Within a cluster
Leader is the only writer

Every write becomes an op appended to an oplog with a monotonic sequence

Leader applies the op to local storage (docs + indexes)

Replicas pull/push ops by sequence and apply idempotently

Because cluster writes are single-writer, conflicts inside a cluster are basically eliminated.

Between clusters (primary/secondary)
Primary cluster’s oplog is authoritative for that table.

Secondary clusters replicate ops from primary when connected.

If you later allow secondaries to write while offline, you’ll still use oplogs and resolve by policy (v2); for v1 you can keep single-writer per table to avoid loss.

Data model
Canonical state: docs table (materialized current value)

Change history: oplog table (append-only; replicates)

That’s the standard “event-sourcing-lite” pattern.

2) Fast filtering: disk + in-memory prefilter
Agree with your performance goal.

Disk-level filter (authoritative)
Use your doc_index so queries don’t scan JSON.

In-memory “hot filter” (real-time, before disk)
On the leader, when an update arrives:

validate & append op

update in-memory cache/index (very small datasets)

publish to subscribers immediately

persist to disk (SQLite/Postgres) asynchronously (still durable if you do WAL/transaction correctly)

For your low write rate (≤1000/day) and small data size, this will be very fast.

Practical: do “publish after commit” if you need strict durability, but you can still keep it under ~500ms easily. If you want “instant UI”, you can publish after in-memory apply and then confirm commit later.

Subscriber filtering in memory
Subscriptions should not run SQL for every event.
Instead:

maintain per-table in-memory index of the fields that are used in filters (same as your configured indexes)

each new/updated object updates that in-memory index

then subscription filters are evaluated on the object/meta directly

3) Simplified filter language (AND-only)
That works great and keeps everything easy to implement and fast.

You want something like:

(obj[key1] < dt1) AND (obj[key1] > dt2) AND (obj[key2] in [v1,v2,v3]) AND substring

Proposed operators (generic, clear names)
lt, lte, gt, gte

eq, neq

in (one_of)

contains (substring)

optional: prefix (faster than contains if you need it)

Filter spec (AND list)
{
  "and": [
    { "field": "createdAtMs", "op": "gte", "value": 1762061000000 },
    { "field": "createdAtMs", "op": "lt",  "value": 1762064600000 },
    { "field": "equipmentId", "op": "in",  "value": ["eq_1","eq_2","eq_3"] },
    { "field": "notes",       "op": "contains", "value": "no onion" }
  ]
}
This is easy to:

translate to index lookups

evaluate in memory

keep consistent across SQLite/Postgres

Index requirements for speed
To make it “really quick”, we enforce:

range ops (lt/lte/gt/gte) must target fields indexed as i64

in/eq/neq on str or i64

contains:

either requires a dedicated text index strategy (v2), OR

in v1 we allow it as a post-filter (in-memory and/or after candidate set), not as the initial disk selection

This keeps v1 fast and simple.

Query execution plan (fast)
Given AND-only, do this:

Choose the most selective indexed predicate as the “driver”:

time range is usually best driver (createdAtMs between A and B)

Fetch candidate IDs from doc_index using that predicate

For remaining predicates:

if indexed: intersect candidate IDs using index lookups

if non-indexed or contains: fetch doc JSON for remaining candidates and test in memory

Apply pagination after final filtering

This is very fast for your data sizes.

4) How this ties into your replication model
Because updates are ops:

replication ships ops, not full tables

indexes (disk + memory) are derived from docs and can be rebuilt

subscriptions can be driven by ops + materialized state

So yes — the design is consistent with “change log as the truth”.

5) One concrete naming suggestion (matching your earlier style)
You can expose it in SDK as:

query_objs(table, {
  and: [
    { field:"createdAtMs", op:"gte", value:startMs },
    { field:"createdAtMs", op:"lt", value:endMs },
    { field:"equipmentId", op:"in", value:["eq_1","eq_2"] }
  ]
})
or in your get_objs:

get_objs("orders", null, { filter: { and:[...] }, start_pos:0, max_count:200 })
If you want, next I can give pseudocode for:

leader write path that appends to oplog, updates in-memory index, publishes subscription events, persists to store

query path that uses your AND-only filters with a “driver predicate” + intersection strategy


I would simplify filter , instead of

{
  and: [
    { field:"createdAtMs", op:"gte", value:startMs },
    { field:"createdAtMs", op:"lt", value:endMs },
    { field:"equipmentId", op:"in", value:["eq_1","eq_2"] }
  ]
}
simply

[
    [ "createdAtMs", ">=", startMs ],
    [ "createdAtMs", "<", endMs ],
    [ "equipmentId", "in", ["eq_1","eq_2"] ]
]

Yep — that’s a great simplification. It’s:

AND-only by default

trivial to parse

compact over the wire

easy to evaluate in memory

easy to translate to index lookups in SQLite/Postgres

Here’s how I’d formalize it.

Filter v1 format (AND list)
A filter is an array of clauses:

[
  [field, op, value],
  [field, op, value],
  ...
]
Supported ops (v1)
Comparisons (numeric/time): "<" "<=" ">" ">=" "==" "!="

Set membership: "in" (value is array)

String match: "contains" (substring, case-sensitive by default)

Optional: "prefix" (faster than contains)

Type rules (keep it fast)
"<" "<=" ">" ">=" require the field to be indexed as i64 (epoch ms, counters, etc.)

"in" / "==" / "!=" require indexed i64 or str

"contains" is post-filter (in-memory after candidate selection) unless you later add a text index

Example (your case)
[
  ["createdAtMs", ">=", startMs],
  ["createdAtMs", "<",  endMs],
  ["equipmentId", "in", ["eq_1","eq_2"]]
]
How query execution uses this (fast path)
Normalize clauses (validate ops, types, index availability)

Pick a driver clause (most selective indexed predicate), typically:

createdAtMs range

or equipmentId ==

Fetch candidate IDs using doc_index for driver

For each remaining clause:

if indexed → intersect candidates using doc_index

if post-filter (contains) → fetch doc JSON for remaining candidates and test in memory

Return results with pagination

This stays fast and simple.

Subscription filtering
Same filter format works for subscribe_objs(table, filter).

Leader evaluates clauses in memory against the updated object (or its indexed fields)

If match → emit event to subscriber

No SQL needed per event

Small extra: sugar for BETWEEN
You don’t need it, because you already do:

>= start and < end

But if you ever want syntactic sugar later:

["createdAtMs", "between", [startMs, endMs]]
(Internally expands to two clauses.)

Where this goes in your existing API
Fits directly:

get_objs(table_name, ids, { filter: [ ... ], start_pos, max_count })
subscribe_objs(table_name, { filter: [ ... ] })
If you want, I can now update the pseudocode for get_objs and subscribe_objs to use this exact clause format (and show the “driver predicate + intersection” logic).


sounds good , I like between as well, I would siplify the final api
get_objs(table_name, ids, { filter: [ ... ], start_pos, max_count })
to
get_objs(table_name, ids, filter, start_pos, max_count ) // where filter is [ ... ]

Works 👍. Here’s a tight v1 definition that includes between, keeps the call signature simple, and stays easy to implement efficiently.

1) Final API signature (v1)
get_objs(table_name, ids=null, filter=null, start_pos=0, max_count=-1)
subscribe_objs(table_name, filter=null, callback, options?)
Where:

ids: array of ids or null

filter: AND-list of clauses or null

start_pos: integer offset

max_count: max results (-1 = no limit / server default cap)

2) Filter format (AND-only)
Clause forms
A filter is an array of clauses:

3-tuple clause

[field, op, value]
Supported ops

Comparisons: "<" "<=" ">" ">=" "==" "!="

Membership: "in" (value is array)

Substring: "contains" (value is string)

Prefix: "prefix" (value is string)

Between (sugar)

[field, "between", [low, high]]
Semantics:

inclusive lower bound, exclusive upper bound by default (best for time windows):

low <= field < high

If you ever want inclusive high, add "between_inclusive" later, but v1 can just define between as [low, high).

Example
filter = [
  ["createdAtMs", "between", [startMs, endMs]],
  ["equipmentId", "in", ["eq_1", "eq_2"]],
  ["status", "!=", 3]
]
3) Evaluation rules (fast + predictable)
Index requirements
"<" "<=" ">" ">=" "between" require field indexed as i64

"==" "!=" "in" require field indexed as i64 or str

"contains" / "prefix":

prefix can be indexed if you keep str_val and use range scan

contains is post-filter (in-memory on candidates) in v1

Normalization step
Backend normalizes between into two clauses internally:

>= low

< high

4) Precedence between ids and filter
To avoid ambiguity, define:

If ids is provided:

fetch those ids (paginated)

if filter is also provided, filter those results (post-filter/in-memory)

If ids is null:

use filter to find ids via indexes

This is very intuitive.

5) Example calls
Orders created in a time window on equipment
const rows = await get_objs(
  "orders",
  null,
  [
    ["createdAtMs", "between", [startMs, endMs]],
    ["equipmentId", "in", ["eq_1", "eq_2"]]
  ],
  0,
  200
)
Fetch explicit ids but only those with status READY
const rows = await get_objs(
  "orders",
  ["ord_1", "ord_2", "ord_3"],
  [["status", "==", "READY"]],
  0,
  -1
)
6) Suggested response shape (unchanged)
Return:

items (each has id/value/meta or miss)

next_pos for pagination

optional watermark info for retention-based “pruned” behavior

If you want, next I’ll revise the pseudocode for get_objs and subscribe_objs to implement this exact filter shape, including:

normalization (between)

choosing driver clause

intersection of candidate id sets using doc_index

post-filter for contains and for “ids + filter” use case


before revising , lets discuss how records are merged between clusters

the offline may have a new order with the same id as a new order in online cluster (online ordering vs offline)
how do you know if its the same record with diferent values or actually different records

Thought for 6s
This is the classic problem, and the honest answer is: with only the ID, you can’t know. If two clusters can create records independently, then IDs must be globally unique or you need an explicit “same logical record” linking key.

So the design has to make one of these true:

Collision is impossible (preferred)

If collision happens, you have deterministic rules to keep both and optionally dedupe.

1) Make collisions impossible: ID must encode origin
If offline and online can both create orders, then orderId must be globally unique across all clusters.

Best practice:

A) Use UUIDv7 / ULID + embed origin prefix
Example:

ord_offlineMiami1_01JH8K...

ord_online_01JH8K...

or

ord_{clusterId}_{ulid}

Then even if both generate the same ULID timestamp segment, the prefix prevents collision.

B) Or generate IDs that are inherently unique without prefix
UUIDv7 (random + time)

UUIDv4 (random)
Collisions are astronomically unlikely, but I still like the prefix because it also helps debugging and routing.

Result: If IDs don’t collide, the merge logic is simple: same id = same record.

2) If you want to detect “same logical order”
If “online ordering” and “offline order capture” might actually refer to the same customer order, you need a separate stable correlation key that survives across systems.

Examples:

externalOrderRef (from the customer web app)

paymentIntentId / processorRef

customerSessionId + cartHash + createdAtBucket

QR code “order token” generated once and reused

Then the merge rule is:

If orderId matches → same record

Else if externalOrderRef matches → treat as same logical order and merge

Else → different records

This is the only correct way to “know”.

3) What if collision still happens anyway?
Even with good IDs, you should define a deterministic collision handler (rare but good hygiene):

Collision case
Offline has orderId = ord_123 and online also has ord_123, but payload differs and origin differs.

Rule
Treat this as two different records and rename one:

Keep the primary’s ID as-is.

For the other, rewrite ID deterministically:

ord_123@online or ord_123#2 or ord_123__conflict__{clusterId}

Store an alias mapping:

aliases[ "ord_123" ] -> ["ord_123", "ord_123@online"]

Now you never lose data, and you can inspect/dedupe later.

4) The cleanest approach for your system
Given your architecture:

Offline cluster is the main order capture location

Online cluster may also create orders (internet ordering)

I’d do this:

Always generate IDs as:
orderId = "ord_" + clusterId + "_" + ULID()

And also include:

originClusterId

originNodeId

createdAtMs

If you want dedupe across online/offline, add:

externalOrderRef (created by the customer web app and included in the order)

Then merges are deterministic and safe.

5) How this affects your oplog / replication model
Oplog operations reference table + id

If IDs are globally unique, oplog merge is straightforward: ops for the same id apply to the same record.

If you also use externalOrderRef, you can implement an optional “dedupe/merge” job that links or merges records that represent the same logical order.

If you tell me one thing—do you intend to allow both offline and online clusters to accept writes for the same table at the same time (multi-writer), or do you want one writer and the other only mirrors? I can then give you the exact merge policy (because multi-writer needs a CRDT/event strategy, while single-writer is much simpler).


using cluster_id as part of id sounds good , in most cases we will only have 2 clusters but at some times in future we may have more. for the UUID , should we use a number to make it faster or string is fast enough ? if a number if we reserve 8 bits for cluster id ad the rest do for incremental number ... would it work or you still recommend has a string or something and timestamp etc in the id ? 

String is fast enough for your scale, but there are tradeoffs. Here’s the decision in a practical way.

What matters most
Uniqueness across clusters (now and future)

Works offline

Easy to generate everywhere (JS/RN, router, Linux)

Good for ordering by time (nice for queries/logs)

Doesn’t require coordination (no shared counter across nodes)

A pure “incrementing number” breaks quickly in distributed/offline unless you add more structure.

Recommendation: keep IDs as strings, but make them compact + sortable
Use:

<tablePrefix>_<clusterIdShort>_<ulid>
Example:

ord_br_01JH8KQ2T9N3Z0W6F4A8…

Where:

clusterIdShort is a short stable identifier (e.g., 2–6 chars base32/base62, derived from the real cluster UUID)

ulid (or UUIDv7) gives:

time-sortable

unique without coordination

easy in JS and server languages

Why this wins

No coordination needed

Very low collision risk

IDs sort by creation time (ULID/UUIDv7)

Still portable and easy to debug

Performance: with <1MB data and ~1000 writes/day, string key comparisons are absolutely fine in SQLite/Postgres.

If you really want numeric IDs
You can do it, but do not do “8-bit cluster id + rest incremental number” unless you’re okay with strong limits and coordination.

Problems with “clusterId + incremental”
If more than one node generates IDs, you need a global counter → coordination → not offline-friendly.

If you do per-node counters, you need node bits too.

8 bits for cluster id = max 256 clusters (maybe fine, maybe not).

You’ll eventually want time ordering and collision safety.

A numeric scheme that actually works (still more complex)
Use a 64-bit “Snowflake-like” ID:

[ 41 bits timestamp_ms ] [ 10 bits cluster ] [ 10 bits node ] [ 3 bits sequence ]
Pros:

sortable

numeric

unique without coordination (as long as node id unique per cluster)
Cons:

more implementation complexity

you must assign stable node ids

careful with clock skew

64-bit integer in JS can overflow unless you use BigInt everywhere (annoying in browser)

Because your client SDK is JS, numeric 64-bit is awkward unless you standardize on BigInt and serialize as string anyway.

So you don’t really escape strings.

Best of both worlds: store ID as string, index a numeric “createdAtMs”
This is what I’d do:

Primary key: string ID (ord_{clusterShort}_{ulid})

Indexed fields:

createdAtMs as i64

maybe idPrefix/clusterShort if useful

Queries should use createdAtMs (numeric), not the string ID, for time ranges.

That gives you fast numeric filtering without fighting JS integer limits.

What about reserving bits for cluster id?
If you want the “cluster encoded” feel, you can still do it with strings:

clusterShort = base32 of first N bits of cluster UUID (say 20–30 bits)

ULID already encodes time + randomness

This is essentially the same benefit without numerical headaches.

Concrete final proposal
clusterShort: 4 chars base32 (~20 bits) derived from cluster UUID

id: "{tablePrefix}_{clusterShort}_{ULID()}"

In every record, also store:

originClusterId (full UUID)

createdAtMs (i64)

This makes merges easy and future-proof for more than 2 clusters.

If you want, I can provide a small JS/RN snippet for generating:

clusterShort from UUID

ULID/UUIDv7-based IDs
and show how it plugs into your add_objs() so every node generates collision-free IDs.


ok, your approach to uuid is acceptable , now explain me better what data structure you are planning in database, is client table stored as a column for each value or in   a separate db table

I’m planning one physical SQL table for all your logical “tables” (what your API calls table_name), plus a separate generic index table.

So: your client “table” is not a separate SQL table. It’s a namespace field (table) inside the universal docs table.

This is what keeps it generic and portable.

1) Physical DB tables (SQLite/Postgres)
A) docs — stores all JSON records (for all logical tables)
Each record is:

db_id (which database/tenant)

table (logical table name, e.g. "orders", "menu")

id (record id, string)

json (the value; JSON text/JSONB)

updated_at_ms (i64)

etag (optional)

deleted (tombstone flag)

Primary key: (db_id, table, id)

So if you do:

add_objs("orders", [{id:"ord_x", value:{...}}])
It becomes one row in docs with table="orders".

✅ Generic, no schema migrations per app table
✅ Works identically on SQLite and Postgres
✅ Easy replication (oplog references db_id/table/id)

B) doc_index — derived searchable fields (generic index)
One row per indexed field per record:

db_id

table

id

field (e.g. "createdAtMs", "equipmentId")

i64_val (for numbers/time)

str_val (for strings)

bool_val (for booleans)

Primary key: (db_id, table, id, field)
(or include a value hash if multi=true)

Indexes for speed:

(db_id, table, field, i64_val)

(db_id, table, field, str_val)

(db_id, table, field, bool_val)

This is what makes your filter fast without scanning JSON.

C) blobs — binary objects (metadata + storage reference)
db_id, table, id

content_type, size, sha256

storage_ref (path on disk or object-storage key)

On tablets: bytes stored as files + metadata here.

D) oplog — append-only change log (for replication)
Leader-only writes append ops:

db_id

op_seq (monotonic integer assigned by leader)

ts_ms

op_type (ADD/UPDATE/REPLACE/DELETE/BLOB_ADD/BLOB_DEL/SCHEMA_*)

table, id

payload (patch/full JSON/etc.)

Replicas pull ops by op_seq.

E) table_config — config for your logical tables
Stores definitions like:

type (json/binary)

indexed fields + types

retention config

writePrimaryClusterId, readFallbackClusters, etc.

Could be its own SQL table or stored in docs under a reserved table like "__meta"—either way.

2) Why not “one SQL table per logical table”?
That would mean creating SQL schema/migrations for every table, and doing it twice (SQLite + Postgres), and keeping them aligned. It’s doable, but:

not generic

adds deployment complexity

hurts “use this backend for many projects”

Your requirements strongly favor the universal docs + doc_index approach.

3) How this answers your question directly
“is client table stored as a column for each value or in a separate db table?”

Your logical table name (e.g., "orders") is stored as a column (table) inside the single physical docs table.

The record’s “value” is stored as one JSON column (json).

Indexed/searchable fields are stored in a separate physical table (doc_index) as typed columns.

So: not a separate SQL table per client table.

4) Example (what actually gets stored)
If you write:

add_objs("orders", [{
  id: "ord_mia1_01J...",
  value: { createdAtMs: 1762061000000, equipmentId: "eq_12", status: 2 }
}])
docs row:

table = "orders"

id = "ord_mia1_01J..."

json = {"createdAtMs":..., "equipmentId":"eq_12", "status":2}

doc_index rows:

field=createdAtMs, i64_val=1762061000000

field=equipmentId, str_val="eq_12" (or hash64 stored in i64_val if you choose)

field=status, i64_val=2

If you want, next I can show:

the exact DDL for SQLite + Postgres for these tables, and

how update_objs() updates docs + rebuilds doc_index rows in one transaction on the leader.


but probably instead of db_id and table in each record we should have only table_id
and separately each table will have configuration that has :


table_name
app ( pos, catering, ... )
db  ( one for each location )
some other metadata (will extend a lot later)


online linux clusters will keep many dbs and much more load , offline clusters will normally have only one

can you estimate how many dbs (offline clusters) can one VPS linux support, lets assum 1GB ram some ssd space etc , standard virtual hosting

if for example 1 can support 100 offline clusters, then for each 100 offline locations we will have a separate VPS and probably one replica

Thought for 10s
Yep — moving from (db_id, table) to a single table_id is a good idea. It reduces per-row storage/index size and makes queries/joins faster.

1) Data structure with table_id
Instead of storing db_id + table_name on every record, you store one integer table_id and keep all metadata in a separate catalog.

Catalog table
tables (one row per logical table instance)

table_id (int/bigint, PK)

table_name (e.g. orders, menu)

app (pos, catering, …)

db (your “location database”, e.g. Miami1)

cluster_write_primary (offline cluster id usually)

fallback_clusters (e.g. online archive cluster)

type (json or binary)

indexes config (or normalized child table)

retention config, etc.

In your terms: db is “one for each location”, and table_id is basically (app, db, table_name) collapsed into an integer.

Docs table
docs

table_id (FK)

id (string record id)

json (TEXT/JSONB)

updated_at_ms (i64)

deleted (bool)

PK: (table_id, id)

Index table
doc_index

table_id

id

field

i64_val / str_val / bool_val

PK: (table_id, id, field) (or include value hash for multi)

indexes: (table_id, field, i64_val) etc.

Oplog
oplog

table_id

op_seq (monotonic per-table leader)

ts_ms

op_type

id

payload

PK: (table_id, op_seq)

This layout is clean and fast on both SQLite and Postgres.

2) How many “offline clusters / dbs” can a 1GB VPS support?
Key point: don’t create a separate Postgres database per offline cluster. Use one Postgres DB with tenant separation via table_id. Postgres “many databases” is operationally heavier (connections, catalogs, maintenance).

Given your workload:

data per offline location: ~≤1MB (typical)

writes: ~≤1000 updates/day/location (very low)

sync frequency 100ms inside cluster is local; WAN sync to VPS can be batched (e.g. 1–5s) and still meet your needs for archive.

What limits a 1GB VPS in practice
Postgres baseline memory (shared buffers, background processes)

number of concurrent connections (each connection costs RAM)

your app process (API server) + TLS overhead

With sane tuning + connection pooling, the storage/IO side is not the limiter at your scale.

Conservative sizing (what I’d plan around)
On a 1GB VPS with Postgres + your API:

100 clusters: very safe

200–500 clusters: realistic if you use pgbouncer / low connection counts and modest sync batching

1000+ clusters: possible only if you’re careful (pooling, fewer connections, lower per-cluster chatter)

So your example “1 VPS supports 100 offline clusters” is totally reasonable and conservative.

Practical recommendation
Assume 200 clusters per 1GB VPS as a starting target

Add a replica (read-only standby) if you need resilience

Use pgbouncer so you don’t die from connection RAM

Keep WAN sync batched (e.g., every 1–2 seconds) instead of pushing every 100ms over the internet

3) Suggested deployment math
If you expect N offline locations, plan:

1 VPS per ~200 locations (1GB class)

1 replica per VPS group if you want failover

If you want more density, bump VPS RAM to 2–4GB and you can comfortably scale into 1000+ locations per VPS group with the same schema.

If you tell me whether you plan to run Postgres + API on the same VPS (likely) and what language you’re leaning for the API server (Node/Go/Rust), I can give a tighter capacity estimate including connection counts and recommended sync batching settings.


I want the same codebase to run on android tablets as well as linux servers, even more ideally on web clients ( client only portion, so it could be different ), something replit will be able to use and integrate as part of one app that have UI portion (done in replit) and server part hopefully built outside with codex

deployment is something like that , I will rent 3 VPS server from different providers, plus additionally have one physical server (windows) at home. for each new customer offline location it will use one of the VPS as a primary for online orders and other 2 VPS as replicas for the same location, if one VPS goes offline then another 2 VPS divide workloads between them until that VPS is back again. When we have more clients than we can handle on 3 VPSs ( technically 2 VPSs) then we add one more VPS

the home server will never become primary , it will be mostly to save all the data. when we have 10 VPS server then each table should have 1 leader node and 2 replica nodes, so each table effectively saved on 3 nodes. All VPS server will be considered one (online) cluster serving potentially thosands of offline clusters.Lets assume one offline cluster produces about 35K records (~100/day) and one VPS servers handle up to 300 offline clusters (as leader) and twice as much as a replica

each offline cluster will typically have 3-10 fire tablets , offline clusters will produce probably 80% of records (20% online)

Thought for 16s
Got it. With your deployment + “same codebase on Fire + Linux (and maybe routers)” requirement, the cleanest design is:

One shared TypeScript core (business logic: tables/docs/index/oplog/filter/replication protocol)

Thin platform adapters (SQLite/Postgres driver, HTTP server, storage paths, timers)

JS SDK for clients (web + RN) that talks to the local/remote node

That gives you:

one codebase that Replit can import (UI + embedded node)

same exact logic runs as a Linux daemon (cloud node)

web clients use only the SDK (client-only portion)

Below is a concrete architecture that matches your multi-VPS layout and the numbers you gave.

1) Codebase layout (one repo, one “core”)
A) core/ (TypeScript, no platform deps)
Implements:

table catalog (table_id, config, indexes list)

change log format (oplog entry types)

apply-op engine (updates docs + doc_index)

filter engine (your AND-clauses + between + in + contains)

replication protocol (push/pull by oplog cursor)

leader lease state machine (abstracted)

retention + watermark logic (local retention + archive fallback)

B) adapters/
Pluggable modules:

storage-sqlite/

Linux: better-sqlite3 (fast, simple)

Android/RN: platform SQLite binding

storage-postgres/

uses JSONB + doc_index tables

http-node/

Node HTTP server + SSE/WebSocket

http-react-native/

in-app HTTP server (or a “direct call” mode for RN UI)

blob-fs/ (files) and blob-s3/ (cloud)

C) node/ (the backend runtime)
Exports startNode({...}) that wires core + adapters.

Runs on Linux VPS as a daemon

Runs inside the RN app (embedded)

D) sdk/ (client library)
Exports your simple APIs:

get_objs(table, ids, filter, start_pos, max_count)

add_objs/update/replace/delete

subscribe_objs(table, filter, cb)

auth helpers (JWT bearer)

SDK decides:

direct embedded calls (RN) or

HTTP calls (web browser, or RN if you want uniformity)

This matches your “Codex builds backend outside, Replit uses it as one app”: publish core/node/sdk as npm packages; Replit UI imports sdk and (on tablets) imports node to start embedded backend.

2) Your online deployment model (3 VPS + grow)
You described: for each offline location (tenant/db), online orders have:

1 leader node

2 replica nodes
across 3 VPS providers.

That’s a good model. You should implement placement as pure deterministic hashing so you don’t need complicated orchestration.

Placement rule (simple, deterministic)
Given a table_id (or dbId), compute:

leader = H(table_id) mod N

replica1 = next node

replica2 = next node

Where N = number of VPS nodes in your online cluster.

This way:

when you add a 4th VPS, you can gradually rebalance (or accept some movement)

failover is simple because the replica nodes already have data

Failover
If leader VPS is down:

replica with the “lowest failover rank” takes leadership lease

it continues serving writes

when original returns, it rejoins as replica

Important: leadership should be per table (or per db) not per server.

3) What does “one online cluster serving thousands of offline clusters” mean in practice?
It means:

All VPS nodes are members of the same online cluster (membership list)

But leadership is sharded by table_id across them

Postgres can be used as the storage backend, but leadership is still in your app layer (lease-based)

For coordination in the online cluster, you can choose:

Option A (simplest): use Postgres advisory locks for leader leases
If you already run Postgres on each VPS, you can use:

pg_try_advisory_lock(table_id_hash) as the leader lease

leases naturally drop if the process dies

This is very robust and avoids building your own consensus service.

Option B: app-level leases + gossip heartbeats
Works too, but more moving parts across 10 VPS.

Given your plan, advisory locks are the pragmatic choice for online.

Offline cluster (Fire tablets) can do app-level leases.

4) Capacity sanity check with your numbers
You said:

~35K records per offline cluster total

~300 offline clusters per VPS as leader

2x as many as replica

~100 records/day per offline cluster

offline generates ~80% of records

Records per VPS (leader responsibility)
300 clusters × 35K records = 10.5M records led by that VPS.

If average record (JSON) is, say, 0.5–1.0 KB, that’s:

10.5M × 0.5KB = ~5.25 GB raw JSON

10.5M × 1KB = ~10.5 GB raw JSON

But you also have:

doc_index rows (often 2–6 per record)

oplog (can be compacted)

overhead/indices

A realistic multiplier is 2–4×.

So per VPS you could be looking at ~15–40 GB of SSD for those 300 leaders, depending on record size and index count.

That’s fine on SSD, but it means your earlier “1GB RAM standard hosting” limit is not storage, it’s mostly:

connection count

caching

API process memory

RAM doesn’t scale with record count directly if you don’t load everything into memory. Keep in-memory indexes limited to “hot window” or “recent changes” only.

Practical target
300 leader clusters per VPS is plausible if:

you keep indexes small (only the fields you truly query)

you prune or compact oplog

you don’t keep long history on the same “hot” Postgres instance without partitioning/archival

5) Offline cluster (3–10 Fire tablets) behavior
Offline cluster:

elects a leader (reachable-by-all)

leader is the only writer

replicas sync every 100ms locally (fine)

WAN replication to online should be batched (e.g. 1–2 seconds) — no need for 100ms over the internet.

Old records pruned locally:

offline keeps last X hours (e.g., 24h)

online keeps longer

get_objs(..., filter) can “fallback” to online if the query is older than offline watermark

6) Home server as “never primary, always archive”
That fits perfectly as:

an additional replication sink

not in leader placement set

pulls from online leaders periodically

stores full history (big disks)

7) One key decision you should lock now
Unit of leadership / sharding on online cluster:

Per db (location): simplest operationally
All tables for Miami1 live together on the same 3 VPS nodes.

Per table_id: more granular, better balance, more complexity

Given your plan (“each location uses one VPS primary and 2 replicas”), you likely mean per db/location, not per table. That’s fine—just make table_id include db.

If you want, I’ll turn this into a concrete “implementation checklist” with:

the exact Postgres schema using table_id

how to implement advisory-lock leader leases

how the SDK decides leader vs replica reads

how batching works for WAN replication (offline→online)

and how rebalancing works when you add the 4th/10th VPS


3a vs 3b , I think 3b make more sense as we already have to implement it for offline clusters anyway ... we also don't want to depend on using postgress as a db, we may decide to do something else

Makes sense. If you don’t want to depend on Postgres features, then 3B (app-level leases + membership/heartbeats) is the right choice—and you can still reuse the same leader-election/replication code in offline and online.

Here’s the clean way to do 3B so it’s robust enough for your multi-VPS setup without pulling in a full consensus system.

1) What 3B really means (in your model)
You have one online cluster (many VPS nodes). For each “shard” (db/location or table_id):

exactly one leader

2 replicas

leader can fail over to replicas

you don’t rely on DB primitives to decide leader

So you need:

membership (who is alive)

leader lease per shard

replication (leader → replicas)

routing (clients know where to send writes)

2) Membership: gossip heartbeats
Every node periodically sends heartbeats to a small set of peers.

Data maintained per node:

nodeId

addr (ip:port)

lastSeenMs

nodeEpoch (random number on process start; helps detect restarts)

capabilities (canLead, storageType, etc.)

Heartbeat interval online: ~250ms–1s
(Offline tablets can be faster; online doesn’t need 100ms for membership.)

A node is “alive” if now - lastSeen < 3 * heartbeat_interval.

3) Leader lease per shard (db or table_id)
You need a lease record:

Lease fields:

shardId (dbId or table_id)

leaderNodeId

leaseEpoch (monotonic “term”)

leaseExpiresAtMs

leaderNodeEpoch (to detect restart)

replicaSet (the 2 replicas for that shard)

Key requirement
To avoid split-brain, the leader must hold a lease that is accepted by enough replicas (or “witnesses”).

You don’t need full Raft for your use case; you can do a quorum-lease.

4) Quorum lease protocol (simple, works for 3 replicas)
Since each shard is stored on 3 nodes (leader + 2 replicas), use quorum = 2 of 3.

Acquire lease (candidate tries to become leader)
Candidate C:

Computes shard’s replica set deterministically (or from config service)

Sends RequestLease(shardId, proposedEpoch, ttlMs) to the other two nodes

Each replica grants if:

it has no unexpired lease for a higher epoch

and it can reach the candidate (optional but good)

Candidate becomes leader if it receives ≥1 grant from other nodes
(together with itself that’s 2/3 quorum)

Renew lease (leader keeps leadership)
Leader periodically sends RenewLease(shardId, leaseEpoch) to replicas.
If it loses quorum, it should step down.

Safety properties
If leader dies, lease expires quickly and a replica can take over.

Split-brain can still happen during network partitions, but quorum reduces it:

only side that can talk to at least one other replica can be leader.

For online VPS deployments (where partitions are rare), this is usually sufficient.

5) “Only node reachable by all replicas can be leader”
You requested this earlier. In quorum-lease terms:

Require candidate to obtain grants from both replicas (3/3) if you want “reachable by all”.

That is stricter and avoids the “leader with only 2/3 connectivity”.

So pick one:

Mode A: Strict (reachable by all)
candidate must get 2 grants (from both replicas)

very safe, but failover may be blocked if one replica is down

Mode B: Quorum (recommended online)
candidate must get 1 grant (2/3)

higher availability, still good safety

Given you want the system to continue when one VPS is down, you likely want Mode B (quorum) for online.

Offline tablets: strict might be OK, but tablets drop frequently; quorum is usually better there too.

6) Routing writes without a central directory
Clients need to know the current leader for a shard.

Do this:

any node can answer: GET /leader?shardId=...

nodes cache leader info and share it in heartbeats

client SDK does:

send write to cached leader

if NOT_LEADER, ask any node for current leader, retry once

This keeps client logic simple.

7) Replication fits perfectly with oplog
Once leader exists:

all writes append to oplog with monotonic op_seq

replicas pull/push ops from leader every 100ms (your requirement)

if leader changes:

new leader must be caught up (it already has most ops as replica)

it continues with a new leaseEpoch (term)

op_seq can remain monotonic per shard if the new leader continues from last applied seq

8) Works regardless of storage backend
This is the big win for 3B:

SQLite, Postgres, RocksDB, whatever — storage is an adapter

election/replication/routing logic stays the same

9) Practical recommendation for your online cluster
Even though you’re building “online cluster serving thousands of offline dbs”:

Do leadership per db (location), not per table, at first.

far fewer leases and leader state

easier ops and debugging

Replica set per db:

choose 3 VPS nodes deterministically using hashing

those 3 nodes run the lease protocol for that db

If you want next, I can write pseudocode for:

RequestLease / GrantLease / RenewLease

leader discovery endpoint

client write retry logic

and how to compute the 3-node replica set for a given dbId with consistent hashing


ok, create me implementation of server component with proper file structure , but instead of real code use pseudo code for each file so I can easily examine it to understand that logic is correct, also create enough docs , that has about.md describing high level project and what is for , it should have specs.md specifying all the requirements , it should have design.md with detail design of the app.  Also add a folder for testing and a folder for playground - easy way for me to test it. Also you need deploy folder where you need scripts to setup whatever is needed, for example if PostrgresSql needed and also config of this. Produce an archive  with all of it . Make sure you have simple script like build.sh to build things and test.sh to test it

Thought for 5s
Here’s the archive with the full server component file structure, pseudocode in each file, and the requested docs / tests / playground / deploy folders, plus build.sh and test.sh:

Download the archive 


ok, lets actuall divide project code and design into few subprojects :
project1 : the goal is to provide universal database/storage interface locally only but it should abstract implementation and provide 2 options for now - SqlLite and PostresSql. It expose all DB apis we discussed but only to a single local node
project2 : cluster coordinator, base functionality to provide node/cluster connectivity, leader election etc, keeps main tables, probably nodes,clusters, locations, this layer is needed for creating the database and possibly other apps/libs , its using project1 to persist data on each node
project3 : multi-cluster universal database/storage that expose everything in multi-cluster environment exactly how we discussed, using project2 , 

basically all sources codes should be in a corresponding separate folder under src, design of upper level should be the same - deploy, dcos, tests, playground etc

make sure each project has document describing its folders/files , interfaces , design etc

but for now just come up with right names and interfaces for each project

Here’s a clean decomposition into 3 subprojects with names + responsibilities + public interfaces, designed so they can share a single TS codebase but remain separable packages.

I’ll use neutral names you can later rename.

Repo layout (top-level)
src/
  project1_store/
  project2_coord/
  project3_multicluster/
docs/
tests/
playground/
deploy/
Each project has its own README.md (design + file map) under src/projectX_*.

Project 1: Local Store Abstraction
Name
project1_store (package name suggestion: @edgelayer/store)

Goal
A single-node local database/storage layer with the generic APIs we defined:

tables (table_id, catalog)

docs (json), blobs (binary)

derived indexes

oplog append/apply (local only)

query/filter (AND-clauses + between)

subscribe (local change bus)

storage backends: SQLite + Postgres

No cluster, no leader election, no replication. It’s “local engine”.

Key public interfaces
1) Store Engine (what higher layers call)
interface StoreEngine {
  // Catalog / schema
  addDb(dbName: string): Promise<void>
  dropDb(dbName: string): Promise<void>

  addTable(app: string, db: string, tableName: string, type: "json"|"binary"): Promise<TableHandle>
  dropTable(tableId: number): Promise<void>

  addIndex(tableId: number, field: string, type: "i64"|"str"|"bool"|"hash64", multi?: boolean): Promise<void>
  setRetention(tableId: number, cfg: RetentionConfig): Promise<void>

  // Data ops (local only; no leader checks)
  getObjs(tableId: number, ids: string[]|null, filter: Filter|null, startPos: number, maxCount: number): Promise<GetResult>
  addObjs(tableId: number, rows: {id:string, value:any}[]): Promise<void>
  updateObjs(tableId: number, rows: {id:string, patch:any}[]): Promise<void>     // merge patch
  replaceObjs(tableId: number, rows: {id:string, value:any}[]): Promise<void>
  deleteObjs(tableId: number, ids: string[]): Promise<void>

  // Blobs
  addBlob(tableId: number, id: string|null, bytes: Uint8Array, contentType: string): Promise<{id:string}>
  deleteBlobs(tableId: number, ids: string[]): Promise<void>
  getBlob(tableId: number, id: string): Promise<{bytes:Uint8Array, contentType:string}>

  // Subscriptions (local bus)
  subscribe(tableId: number, filter: Filter|null, cb: (evt: ChangeEvent)=>void): Unsubscribe

  // Oplog access (needed by replication layers)
  readOpsSince(tableId: number, afterSeq: number, limit: number): Promise<Op[]>
  getLatestSeq(tableId: number): Promise<number>
}
2) Storage adapters (pluggable)
interface StorageAdapter {
  // low-level persistence for catalog/docs/index/oplog/blobs/watermarks
}
Types
Filter = list of clauses [[field, op, value], ...] supporting between

Op = oplog entry

ChangeEvent = added|updated|deleted etc.

Files (suggested)
project1_store/
  README.md
  engine/
    store_engine.ts
    change_bus.ts
  catalog/
    table_catalog.ts
  oplog/
    oplog.ts
    apply_engine.ts
  index/
    indexer.ts
  query/
    filter.ts
    query_engine.ts
  adapters/
    sqlite_adapter.ts
    postgres_adapter.ts
    blob_fs.ts
Project 2: Cluster Coordinator
Name
project2_coord (package name: @edgelayer/coord)

Goal
Provide node/cluster connectivity + leader election + replication plumbing.
It owns the “system tables” like:

nodes

clusters

locations

shards (placement)

leases (logical)

configuration

It uses Project1 (StoreEngine) to persist its own state.

This layer does not implement multi-cluster primary/archive semantics yet; it only:

forms a cluster

elects leaders for shards

replicates ops within one cluster (leader→replicas)

answers “who is leader for shard X”

provides consistent membership view

Key public interfaces
1) Coordinator Node Runtime
interface CoordinatorNode {
  start(): Promise<void>
  stop(): Promise<void>

  // membership
  getAliveNodes(): NodeInfo[]
  onHeartbeat(peer: NodeInfo): void

  // shard placement (3 nodes per shard typically)
  computeReplicaSet(shardId: string): NodeId[]
  getShardLeader(shardId: string): NodeId|null

  // leader lease lifecycle
  tryAcquireLeadership(shardId: string): Promise<boolean>
  renewLeadership(shardId: string): Promise<boolean>
  stepDown(shardId: string): Promise<void>

  // replication within cluster
  pushOps(shardId: string, tableId: number, ops: Op[]): Promise<Ack>
  pullOps(shardId: string, tableId: number, afterSeq: number, limit: number): Promise<Op[]>

  // system catalog helpers
  registerNode(info: NodeRegistration): Promise<void>
  updateNodeStatus(partial: Partial<NodeInfo>): Promise<void>
}
2) Lease protocol RPC surface (internal)
interface LeaseRpc {
  RequestLease(req: RequestLease): Promise<LeaseGrant>
  RenewLease(req: RenewLease): Promise<LeaseRenewResult>
}
3) Replication manager (internal)
interface ReplicationManager {
  startShardReplication(shardId: string): void
  stopShardReplication(shardId: string): void
}
Files (suggested)
project2_coord/
  README.md
  membership/
    gossip.ts
    member_table.ts
  election/
    lease_manager.ts
    lease_rpc.ts
    shard_placement.ts
  replication/
    repl_manager.ts
    repl_rpc.ts
    cursors.ts
  sys_tables/
    schema.ts          // definitions for nodes/clusters/locations/etc.
    bootstrap.ts       // creates required system tables using project1
  runtime/
    coordinator_node.ts
Project 3: Multi-cluster Universal Storage
Name
project3_multicluster (package name: @edgelayer/multicluster)

Goal
Expose the full behavior you described:

multi-cluster topology (offline + online + archive/home)

per-table write authority (“writePrimaryClusterId”)

read fallback clusters for pruned history

local retention + watermarks

merge behavior rules (single-writer per table in v1)

client-facing APIs (get/add/update/replace/delete/subscribe)

routing to the correct leader/shard automatically (using Project2)

Project3 is the “real product API layer”.

It uses:

Project2 for leader election + intra-cluster replication + leader discovery

Project1 for local persistence and oplog apply

plus WAN replication between clusters (offline→online batching)

Key public interfaces
1) MultiCluster API (server-side)
interface MultiClusterDb {
  // resolve table_id and enforce table policy
  resolveTable(app: string, db: string, tableName: string): Promise<number>

  // reads
  get_objs(table: string, ids: string[]|null, filter: Filter|null, startPos: number, maxCount: number, opts?: ReadOpts): Promise<GetResult>
  subscribe_objs(table: string, filter: Filter|null, cb: (evt)=>void, opts?: SubOpts): Unsubscribe

  // writes (always routed to leader of the write-primary cluster for that table)
  add_objs(table: string, rows: Row[]): Promise<void>
  update_objs(table: string, rows: PatchRow[]): Promise<void>
  replace_objs(table: string, rows: Row[]): Promise<void>
  delete_objs(table: string, ids: string[]): Promise<void>

  // blobs
  add_blob(table: string, ...): Promise<{id:string}>
  delete_blobs(table: string, ids: string[]): Promise<void>

  // policies
  set_table_policy(tableId: number, policy: TablePolicy): Promise<void>
}
2) Table policy model (core to multi-cluster)
type TablePolicy = {
  writePrimaryClusterId: string
  readFallbackClusters: string[]
  localRetentionHoursByCluster: Record<string, number>
  timeField?: string
  // v1: single-writer only; v2 could add conflict policy
}
3) Cross-cluster replication (WAN)
interface CrossClusterSync {
  // batch ops from offline primary -> online archive/replicas
  syncTable(tableId: number, fromClusterId: string, toClusterId: string): Promise<void>
}
Files (suggested)
project3_multicluster/
  README.md
  api/
    multicluster_db.ts
    routing.ts              // chooses cluster leader based on policy/shard
    fallback.ts             // watermark-based read fallback
  policy/
    table_policy.ts
    retention.ts
  sync/
    wan_sync.ts             // offline->online batching
    sync_protocol.ts
  server/
    http_api.ts             // REST that SDK calls (hidden)
    auth.ts                 // JWT mint/verify (can be shared)
How these projects depend on each other
Project1_store: zero dependencies on cluster concepts

Project2_coord: depends on Project1_store

Project3_multicluster: depends on Project2_coord + Project1_store

This lets you:

run Project1 alone for embedded local apps

add Project2 when you need clustering

add Project3 when you need offline/online multi-cluster behavior

Naming suggestions (cleaner “real” names)
If you want nicer names:

Project1: edgestore (storage engine)

Project2: edgecoord (coordination)

Project3: edgenetdb or edgefabric (multi-cluster DB)

Package names:

@helenabox/edgestore

@helenabox/edgecoord

@helenabox/edgefabric

If you want next, I can regenerate the archive structure accordingly (same docs/deploy/tests/playground at top, and per-project READMEs + folder maps under src/).


Ok, lets call these projects : steng(storage engine), cord(cluster coordinator) and netab (network tables),

I also don't see APIs defined for storage adapters in steng project, the APIs should be the same for both SqlLite and PostrgreSql implementations

Got it.

steng = storage engine

cord = cluster coordinator

netab = multi-cluster network tables

And yes: SQLite and Postgres adapters must implement the exact same interface (same methods, same semantics). steng’s public API calls into that adapter interface; the rest of the code never cares which DB is underneath.

Below is the concrete naming + interfaces for all three projects, with a fully defined adapter API for steng.

0) Folder naming
src/
  steng/
  cord/
  netab/
1) steng (Storage Engine)
1.1 Public API (what cord/netab or a single node calls)
This is the “single-node DB” API you already like, but internally it’s built from:

catalog + docs + doc_index + oplog + blobs + watermark

// steng/public.ts
type FilterClause = [string, string, any]          // [field, op, value], AND-only
type Filter = FilterClause[] | null               // supports "between" clause form too

type GetResult = { items: ObjRow[], next_pos: number, watermark?: Watermark }
type ObjRow = { id: string, value?: any, meta?: any, miss?: "NOT_FOUND"|"PRUNED" }

type ChangeEvent = { ts: number, op: "added"|"updated"|"deleted", id: string, value?: any }
type Unsub = () => void

interface Steng {
  // Catalog / schema
  ensure_table(app: string, db: string, table_name: string, type: "json"|"binary"): Promise<TableInfo>  // returns table_id
  drop_table(table_id: number): Promise<void>

  add_index(table_id: number, field: string, idx_type: "i64"|"str"|"bool"|"hash64", multi?: boolean): Promise<void>
  set_table_config(table_id: number, patch: Partial<TableConfig>): Promise<void> // retention/timeField/etc.

  // Data reads
  get_objs(table_id: number, ids: string[]|null, filter: Filter|null, start_pos?: number, max_count?: number): Promise<GetResult>
  subscribe_objs(table_id: number, filter: Filter|null, cb: (evt:ChangeEvent)=>void): Unsub

  // Data writes (local engine doesn't enforce "leader-only"—cord/netab do)
  add_objs(table_id: number, rows: {id:string, value:any}[]): Promise<void>
  update_objs(table_id: number, rows: {id:string, patch:any}[]): Promise<void> // merge patch
  replace_objs(table_id: number, rows: {id:string, value:any}[]): Promise<void>
  delete_objs(table_id: number, ids: string[]): Promise<void>

  // Blob ops
  add_blob(table_id: number, id: string|null, bytes: Uint8Array, contentType: string): Promise<{id:string}>
  delete_blobs(table_id: number, ids: string[]): Promise<void>
  get_blob(table_id: number, id: string): Promise<{bytes:Uint8Array, contentType:string}>

  // Oplog access (for replication layers)
  read_ops_since(table_id: number, after_seq: number, limit: number): Promise<Op[]>
  latest_seq(table_id: number): Promise<number>

  // Retention
  get_watermark(table_id: number): Promise<Watermark|null>
  set_watermark(table_id: number, wm: Watermark): Promise<void>
}
1.2 The Storage Adapter API (SQLite and Postgres implement the SAME thing)
This is what you’re asking for: a single adapter interface with identical semantics.

Key design choice:

steng core logic manages behavior (index rebuild, query planning, oplog apply ordering).

the adapter provides primitive operations (atomic transactions, basic CRUD, index clause query).

both SQLite/Postgres implement identical functions.

Adapter interface
// steng/adapter.ts

type TableId = number
type TableType = "json"|"binary"

type TableInfo = {
  table_id: TableId
  app: string
  db: string
  table_name: string
  type: TableType
  config_json: any           // includes indexes, retention, policies
}

type IndexRow = { table_id:TableId, id:string, field:string, i64?:number, str?:string, bool?:boolean }

type DocRow = {
  id: string
  json: any | null           // null allowed for tombstone
  updated_at_ms: number
  deleted: boolean
  etag?: string | null
}

type Op = {
  table_id: TableId
  op_seq: number
  ts_ms: number
  op_type: "ADD"|"UPDATE"|"REPLACE"|"DELETE"|"BLOB_ADD"|"BLOB_DEL"|"SCHEMA"
  id: string
  payload: any               // JSON payload (patch/full/etc.)
}

type Watermark = { localMinTimeMs?: number }

type IndexClause = [string, string, any] // normalized single clause (no between)

interface StengAdapter {
  // ---- Transactions ----
  tx<T>(fn: () => T): T

  // ---- Catalog ----
  catalog_get_by_name(app: string, db: string, table_name: string): TableInfo | null
  catalog_get_by_id(table_id: TableId): TableInfo | null
  catalog_create(info: Omit<TableInfo,"table_id">): TableInfo      // allocates table_id
  catalog_update(table_id: TableId, patch: Partial<TableInfo>): TableInfo
  catalog_list(app?: string, db?: string): TableInfo[]

  // ---- Docs (materialized current state) ----
  docs_get(table_id: TableId, id: string): DocRow | null
  docs_get_many(table_id: TableId, ids: string[]): Map<string, DocRow>
  docs_upsert(table_id: TableId, id: string, json: any, meta: {ts_ms:number, etag?:string}): void
  docs_tombstone(table_id: TableId, id: string, meta: {ts_ms:number, etag?:string}): void

  // ---- Index (derived) ----
  index_delete_all(table_id: TableId, id: string): void
  index_insert(row: IndexRow): void

  // Clause query primitive: returns IDs matching ONE clause using doc_index
  // steng core will do intersection and post-filters.
  index_query_ids(table_id: TableId, clause: IndexClause, start_pos?: number, max_count?: number): string[]

  // Optional helper: for prefix scans if supported efficiently
  // index_prefix_ids(table_id, field, prefix, ...): string[]

  // ---- Oplog (append-only) ----
  oplog_latest_seq(table_id: TableId): number
  oplog_append(op: Op): void
  oplog_read_since(table_id: TableId, after_seq: number, limit: number): Op[]

  // ---- Watermarks ----
  watermark_get(table_id: TableId): Watermark | null
  watermark_set(table_id: TableId, wm: Watermark): void

  // ---- Blobs ----
  blobs_put_meta(table_id: TableId, id: string, meta: {contentType:string,size:number,sha256:string,storage_ref:string}): void
  blobs_get_meta(table_id: TableId, id: string): any | null
  blobs_delete_meta(table_id: TableId, id: string): void

  // Blob bytes are stored outside the DB by a BlobStore (filesystem/S3), also pluggable:
  // see BlobStore interface below
}
BlobStore interface (also identical across platforms)
// steng/blob_store.ts
interface BlobStore {
  put(table_id: number, blob_id: string, bytes: Uint8Array): Promise<string> // returns storage_ref
  get(storage_ref: string): Promise<Uint8Array>
  del(storage_ref: string): Promise<void>
}
Why this is the right split
SQLite/Postgres differences stay inside the adapter.

steng core keeps all behavior consistent:

index rebuild rules

filter normalization and query plan

oplog semantics

tombstones, etc.

1.3 “Same semantics” details (important)
To ensure both adapters behave identically, define these invariants:

tx(fn) is atomic; if fn throws, rollback.

docs_upsert overwrites current doc and clears deleted=false.

docs_tombstone sets deleted=true and retains updated_at_ms.

index_delete_all + inserts happen in same tx as docs update.

oplog_append must fail if op_seq already exists for (table_id, op_seq).

op_seq monotonic per table_id (enforced by steng core; adapter can just store).

index_query_ids returns stable order (ascending by id or by i64_val if range), so pagination works.

2) cord (Cluster Coordinator)
cord depends on steng, but adds:

membership gossip

shard placement (deterministic mapping db/location → 3 nodes)

quorum lease (leader election)

intra-cluster replication of oplog

cord public interface (high level)
interface CordNode {
  start(): Promise<void>
  stop(): Promise<void>

  // leader discovery
  get_leader(shard_id: string): NodeId|null

  // replication plumbing
  replicate_tick(): Promise<void>

  // RPC handlers for lease + replication
  RequestLease(req): Promise<Grant>
  RenewLease(req): Promise<Ack>
  PushOps(req): Promise<Ack>
}
cord persists its own sys-tables (nodes, leases, etc.) using steng tables.

3) netab (Network Tables, multi-cluster)
netab uses:

steng for local persistence

cord for cluster coordination
and adds:

multi-cluster table policy:

writePrimaryClusterId

readFallbackClusters

local retention per cluster

routing of reads/writes to the right leader node

WAN sync batching offline→online

netab public interface (the one your apps use server-side)
It exposes your simplified API signature:

interface NetabApi {
  get_objs(table_name: string, ids: string[]|null, filter: Filter|null, start_pos?: number, max_count?: number): Promise<GetResult>
  subscribe_objs(table_name: string, filter: Filter|null, cb): Unsub

  add_objs(table_name: string, rows): Promise<void>
  update_objs(table_name: string, rows): Promise<void>
  replace_objs(table_name: string, rows): Promise<void>
  delete_objs(table_name: string, ids: string[]): Promise<void>
}
Internally it:

resolves table_name → table_id using catalog (steng)

determines shard (db/location) and leader (cord)

routes writes to leader

applies fallback reads when needed

Quick check: your requirement “same codebase on tablets + Linux”
This design supports it cleanly:

On tablets (embedded): use steng + cord + netab inside one RN app.

On Linux VPS: run cord+netab as a daemon; steng adapter is Postgres or SQLite.

On web clients: use only SDK that talks HTTP to netab.

If you want next, I can list the exact file skeleton for each project under src/steng, src/cord, src/netab (names only, no code) so you can confirm structure before generating a new archive.


The Storage Adapter API should be super simple that is common for SQL databases, this layer should not have any logic that we are trying to do , it should be super easy to add new databases, there  are no concepts of oplog, watermark, blobs etc in standard SQL databases

Totally fair. Let’s make the SQL adapter layer “boringly generic”—a thin wrapper around a SQL connection that only knows how to:

run queries / exec statements

do transactions

do basic migrations / table existence checks

bind parameters safely

Everything domain-specific (docs, doc_index, oplog, watermarks, blobs, catalog) lives above the adapter in steng core.

So the adapter becomes: “a DB driver interface”.

Revised layering
Layer 0: sqldb (super simple SQL DB adapter)
Common for SQLite/Postgres/anything SQL.

Interface
interface SqlDb {
  // connect/close handled by implementation
  close(): Promise<void>

  // Transaction wrapper (must be atomic)
  tx<T>(fn: (db: SqlDb) => Promise<T>): Promise<T>

  // Execute statements
  exec(sql: string, params?: any[]): Promise<{ rowsAffected: number }>

  // Query returning rows
  query<T = any>(sql: string, params?: any[]): Promise<T[]>

  // Query returning single row or null
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | null>
}
That’s it. No oplog, no watermark, no blobs, no special semantics.

Implementations
SqliteDb implements SqlDb

PostgresDb implements SqlDb

Both map:

? params (SQLite) vs $1..$n params (Postgres) — you normalize in implementation.

Layer 1: steng (storage engine, DB-agnostic logic)
steng uses only SqlDb to implement all higher-level tables and semantics.

steng does define:

catalog tables

docs tables

index tables

oplog tables

watermark tables

blob metadata tables

…but those are steng’s schema, not the adapter’s concern.

So steng has a Repo/Dao layer built on SqlDb:

class StengRepo {
  constructor(private db: SqlDb) {}

  // examples — this is where docs/index/oplog/watermark are implemented
  async docsGet(tableId: number, id: string) { ... }
  async docsUpsert(...) { ... }
  async indexQueryIds(...) { ... }
  async oplogAppend(...) { ... }
}
And then steng’s Engine uses the repo and adds logic (merge patch, index rebuild, query planning).

Why this is better
Adding a new SQL database is easy: implement ~5 methods (tx/exec/query/queryOne/close)

steng is the only place that knows about oplog/watermark/docs/index

The “schema” for steng is consistent across all SQL backends (same logical tables), with tiny dialect differences handled in repo SQL strings.

Where blobs fit
Even blobs shouldn’t be in the SQL adapter.

Use a separate, equally generic interface:

interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<string>  // returns storageRef
  get(storageRef: string): Promise<Uint8Array>
  del(storageRef: string): Promise<void>
}
tablets: filesystem blob store

servers: filesystem or S3/minio

steng stores only metadata in SQL.

What steng exposes (unchanged for callers)
Your high-level steng API remains:

add_table/add_index/get_objs/subscribe/add/update/replace/delete

plus internal oplog functions for replication layers

But those concepts exist in steng, not in the adapter.

Concrete naming in your new project split
Inside src/steng/ you’d have:

src/steng/
  sqldb/              <-- super simple adapter interface + impls
    sqldb.ts          (SqlDb interface)
    sqlite_db.ts      (implements SqlDb)
    postgres_db.ts    (implements SqlDb)
  repo/               <-- steng schema + SQL queries
    migrations.ts
    catalog_repo.ts
    docs_repo.ts
    index_repo.ts
    oplog_repo.ts
    watermark_repo.ts
    blob_meta_repo.ts
  engine/             <-- logic
    steng_engine.ts
    query_engine.ts
    apply_engine.ts
    change_bus.ts
So “adding MySQL” later is just mysql_db.ts implementing SqlDb, and possibly small SQL dialect tweaks in the repo layer (mostly in migrations and JSON column type).

If you want, I can propose the minimal SQL schema that steng uses (portable between SQLite and Postgres) while still supporting:

table_id catalog

docs JSON

doc_index typed

oplog

watermarks

blob metadata


ok, show me netab public APIs and lets discuss it

Here’s a clean netab public API that matches everything we discussed:

generic (no POS helpers)

multi-cluster aware (routes to leaders, uses fallback for pruned history)

oplog-based under the hood

simple filter syntax ([[field, op, value], ...] + between)

works for web + RN via a JS SDK

I’ll show it in 3 layers so it’s easy to discuss:

Netab SDK API (what your apps call)

Netab Node API (server-side surface the SDK talks to)

Behavior rules (routing, fallback, consistency)

1) Netab SDK API (public, simple)
Create client
createNetabClient(opts)
type NetabClientOpts = {
  baseUrl: string            // e.g. https://brasao.helenabox.com OR http://127.0.0.1:33445
  app: string                // "pos", "catering", ...
  db: string                 // location/tenant, e.g. "Miami1"
  token?: string             // JWT
  // optional: fallback endpoints (online archive)
  fallbacks?: { baseUrl: string }[]
  // optional: read preferences
  readPreference?: "leader" | "replica" | "nearest"
}

type Clause = [string, string, any]
type Filter = Clause[] | null

type ObjRow = { id: string, value?: any, meta?: any, miss?: "NOT_FOUND"|"PRUNED" }
type GetResult = { items: ObjRow[], next_pos: number, source?: "local"|"fallback", watermark?: any }

type SubEvent = { op: "added"|"updated"|"deleted", id: string, ts: number, value?: any }
type Unsub = () => void
Auth (JWT)
client.auth.setToken(jwt: string): void
client.auth.anonymous(hint?: { brand?: string }): Promise<string>   // gets and sets JWT
client.auth.pin(pin: string): Promise<string>                      // gets and sets JWT
Core object APIs (the ones you want)
client.get_objs(table_name: string,
                ids?: string[]|null,
                filter?: Filter|null,
                start_pos?: number,
                max_count?: number,
                opts?: { readMode?: "local_only"|"local_then_fallback"|"fallback_only" }): Promise<GetResult>

client.add_objs(table_name: string,
                rows: { id?: string, value: any }[],
                opts?: { idMode?: "client"|"server" }): Promise<{ ids: string[] }>

client.update_objs(table_name: string,
                   ids: string[],
                   patches: any[],
                   opts?: { merge?: "shallow"|"deep" }): Promise<void>

client.replace_objs(table_name: string,
                    ids: string[],
                    values: any[]): Promise<void>

client.delete_objs(table_name: string,
                   ids: string[]): Promise<void>

client.subscribe_objs(table_name: string,
                      filter: Filter|null,
                      cb: (evt: SubEvent) => void,
                      opts?: { includeValues?: boolean }): Unsub
Notes
Writes always go to the correct leader (netab handles routing).

Reads can come from replicas, and can fall back to archive when local retention prunes old data.

2) Netab Node API (server endpoints, hidden behind SDK)
The SDK calls these. Same interface for embedded tablet node and VPS node.

Table resolution
Netab must resolve table_name in the context of (app, db) to a table_id.
This is internal, but the SDK always sends app and db (from client opts).

Endpoints (conceptual)
POST /v1/netab/table/ensure → returns {table_id, config}

POST /v1/netab/objs/get

POST /v1/netab/objs/add

POST /v1/netab/objs/update

POST /v1/netab/objs/replace

POST /v1/netab/objs/delete

GET /v1/netab/objs/subscribe (SSE)

Netab node internally uses:

cord to determine leader/replica set for this (app, db) shard

steng to read/write local state and oplog

3) Netab behavior rules (important semantics)
3.1 IDs and collisions across clusters
Netab strongly recommends (and can enforce optionally):

if client supplies an id → it must include clusterShort prefix

else server generates:

id = <prefix>_<clusterShort>_<ulid/uuidv7>

This prevents collisions when offline and online both create records.

3.2 Routing writes
For any write call (add/update/replace/delete):

Resolve (app, db, table_name) → table_id

Determine table policy:

writePrimaryClusterId for the table

Use cord to find leader for that shard in that cluster

Send the write request to that leader

Leader appends oplog, applies, replicates to its replicas

If leader changes, SDK retries after receiving NOT_LEADER + new leader hint.

3.3 Reads, retention, and fallback
For reads:

default readMode = "local_then_fallback"

node checks watermark for that table:

if filter is entirely older than localMinTimeMs → return PRUNED or auto-fallback

If requested ids are missing locally, it can:

return miss: PRUNED and SDK queries online fallback, or

netab node itself proxies to fallback cluster (optional)

Recommendation v1: SDK-side fallback (simpler edge node).

3.4 Filter format (your simplified version)
Filter is AND-only list:

[
  ["createdAtMs", "between", [startMs, endMs]],
  ["equipmentId", "in", ["eq_1","eq_2"]],
  ["status", "!=", 3]
]
Ops supported:

< <= > >= == != in contains prefix between

Netab normalizes between into >= and <.

3.5 Subscriptions
Subscriptions are against the local cluster leader (or a replica if it has a change bus fed by replication).

Filter evaluated in memory on each change event

Events can be id-only or include value

Subscription does not automatically “merge across fallback clusters” (keeps semantics simple)

4) Questions to decide now (to finalize netab API)
We can keep the API above, but a couple knobs matter:

Should netab enforce that writes only happen on the table’s primary cluster?
(v1 recommendation: yes, for safety. Offline is primary for orders; online is primary for online-only tables.)

Should add_objs always accept client-provided ids, or should the server always generate ids?
(I recommend server-generated by default with idMode="server"; allow client ids for special cases.)

For update_objs, do you want shallow merge only?
(Shallow is simpler + predictable; deep merge can surprise people.)

If you want, I can rewrite the netab public API into a single “interface block” exactly like your style (function signatures only) and then we can walk through specific call flows (offline write → online archive → query old window with fallback).


ok, now lets discuss how this APIs would be used by an application , for example POS application
where we create a cluster of "offline" nodes (tablets mostly), then we add and get data to/from database

show me an example how it would use our APIs , especially I'm interested in the initial steps, when new tablets are just initialized , normally we would ask user for a location ( and "connect" to one if exist) , then a brand (new or existing) finally add/get menus

Below is a concrete “day-0 / first run” flow for a POS app using netab APIs (generic tables, no POS helpers). I’ll show it as application pseudocode and call out what happens on the wire vs locally.

I’ll assume:

Each offline location = one db (e.g., "Miami1")

app = "pos"

Your offline cluster is tablets on the same LAN

Leader election + replication is handled by cord inside the embedded node

Storage is handled by steng

App code talks to netab SDK

0) What the POS app bundles/runs on each tablet
On each tablet, at app start:

Start embedded node runtime (steng + cord + netab HTTP)

Create a local NetabClient pointed at localhost

Run “first-run setup” if no configured location/brand

// tablet bootstrap (runs on every tablet)
startEmbeddedNode({
  nodeId: getDeviceId(),
  clusterId: "offline",        // or derive from router / event
  role: "leader_eligible",
  listen: { host:"0.0.0.0", port:33445 } // allow LAN access if needed
})

// client talking to local node
const client = createNetabClient({
  baseUrl: "http://127.0.0.1:33445",
  app: "pos",
  db: null,        // not chosen yet
  token: null
})
At this point tablets will discover each other and cord will elect a leader automatically. Your app doesn’t need to pick a leader.

1) Step 1: User chooses a Location (“db”)
Goal: show user a list of existing locations on this LAN cluster, or create a new one.

Where are locations stored?
In a generic table named, say, "locations" under app="pos" but stored in a special db that all tablets know before a location is chosen. Two options:

Option A (simpler): use a fixed bootstrap db: db="_bootstrap"

Option B: store it in device config only (less shareable)

I recommend Option A so locations are discoverable across tablets.

Application code: list existing locations
// point client at bootstrap db
client.setDb("_bootstrap")

// locations are stored as records in table "locations"
const res = await client.get_objs("locations", null, null, 0, 200)
// res.items -> [{id, value}, ...]
Create a new location if needed
const locationId = "Miami1"  // user input or generated

await client.add_objs("locations", [{
  id: `loc_${locationId}`,    // stable key
  value: {
    db: locationId,
    displayName: "Miami 1",
    createdAtMs: Date.now()
  }
}], { idMode:"client" })
Now every tablet will see that location record (because it replicates inside the offline cluster).

2) Step 2: “Connect” tablet to that location
This is just setting local config + switching the netab client to use that db.

await saveLocalConfig({ app:"pos", db: locationId })  // local storage on tablet
client.setDb(locationId)
At this moment, your embedded node will treat this tablet as participating in the shard/db "Miami1" inside the offline cluster.

3) Step 3: Choose Brand (new or existing)
Brands also stored as a generic table, per location db.

List brands for the location
const brands = await client.get_objs("brands", null, null, 0, 200)
Create new brand if needed
const brandKey = "brasao"

await client.add_objs("brands", [{
  id: `brand_${brandKey}`,
  value: {
    brand: brandKey,
    displayName: "Brasão",
    createdAtMs: Date.now(),
    // later: online domain mapping brasao.helenabox.com, etc.
    domain: `${brandKey}.helenabox.com`
  }
}], { idMode:"client" })
4) Step 4: Load or create Menu tables for that brand
Here’s the important modeling choice:

Keep menu items in a "menu_items" table

Scope them by brand using an indexed field brand

avoids creating per-brand tables

makes querying easy (brand == brasao)

Use indexes: brand (str/hash64), isActive (bool), updatedAtMs (i64)

Ensure indexes exist (admin-only; usually done once)
In practice you’d do this on first run if missing.

// This is done via steng schema config underneath.
// If netab exposes schema ops, you call them once:
await client.ensure_table("menu_items", "json")           // optional helper
await client.add_index("menu_items", "brand", "str")
await client.add_index("menu_items", "updatedAtMs", "i64")
await client.add_index("menu_items", "isActive", "bool")
(If you don’t want schema ops in netab SDK, you can ship schema as part of app bootstrap and apply it automatically.)

Query menu for the selected brand
const menuRes = await client.get_objs(
  "menu_items",
  null,
  [
    ["brand", "==", brandKey],
    ["isActive", "==", true]
  ],
  0,
  500
)
If empty, you can seed defaults or prompt user to add items.

Add/update a menu item
await client.add_objs("menu_items", [{
  id: `mi_${brandKey}_taco_asada`,
  value: {
    brand: brandKey,
    sku: "taco_asada",
    name: "Asada Taco",
    priceCents: 449,
    isActive: true,
    updatedAtMs: Date.now()
  }
}], { idMode:"client" })

// update just price
await client.update_objs(
  "menu_items",
  [`mi_${brandKey}_taco_asada`],
  [{ priceCents: 499, updatedAtMs: Date.now() }]
)
Because updates are oplog ops under the hood, they replicate fast within the cluster.

5) (Optional but common) Subscribe to menu changes
So all tablets update their UI within ~500ms:

const unsub = client.subscribe_objs(
  "menu_items",
  [["brand","==",brandKey]],
  (evt) => {
    // evt.op: added/updated/deleted
    // evt.id
    // evt.value optional if includeValues
    refreshMenuUI()
  },
  { includeValues: false }
)
6) What changes when a new tablet joins later
This is the part you said you care about most.

New tablet first run (same steps)
Start embedded node

cord discovers peers, becomes replica (or could become leader if conditions)

Tablet points to _bootstrap and fetches locations

User selects location + brand

Tablet queries menu_items for that brand

Because replication is oplog-based:

the new tablet’s local steng db is initially empty

cord replication pulls oplog from leader and applies it

within seconds it has the same locations/brands/menu_items

User experience:

locations appear quickly

menus appear as soon as sync catches up (typically <1–2 seconds, often faster on LAN)

7) Where “connect to one if exists” happens
There are two levels:

Cluster connect (automatic)
cord joins LAN cluster automatically via discovery.

Location connect (user choice)
The user chooses the db (“Miami1”).

This just sets the client’s db context + local config.

8) A small refinement for “no clicks” later
Once you have a tablet configured, persist:

lastDb

lastBrand

Then on restart:

auto-connect and load menu immediately

only show setup screen if no config exists

If you want, next I can show the exact same flow but including:

online cluster presence (fallback for old records)

initial anonymous token vs staff PIN token

and how to generate / store the clusterShort used in record IDs


my pseudo code would be like this - 

add a tablet --> 
// on an app startup we request from <api_portal> or specified IP
cluster_obj = register_node(unique_node_id,type:”FireTablet” ) 
// at this time we know its a new tablet, user is choosing create a new Location or connect to one
if ( ui_is_a_new_location ) { // new location
    create_new_cluster(“name”:”loc_name”,”address”:”<address>”)
    select_brand // new or existing 
    set_obj_prop(table:brand,{ “cluster”:”<cluster_id>”}) // what should we do for online clusters ?
    db_name = <cluster_id>.<brand_id>
    … add_menu … } else { // existing location
    brand_list = get_all_brands_for_cluster(cluster_id)
    for_each brand : load_menu(brand)  }

client --> 
// on an app startup we request from <api_portal> or specified IP
cluster_obj = register_node(unique_node_id,{type:”WebClient”,loc:”<url:brasao.helenabox.com>”} ) 
brand_list = get_all_brands_for_cluster(cluster_id)
for_each brand : load_menu(brand)  

Your pseudocode is very close. The main thing to tighten is what objects exist and where, so you don’t end up mixing “cluster”, “location”, “brand”, and “db_name” in a way that becomes hard later—especially with online/offline.

A clean mental model that fits your flow:

cord cluster = a networking/election domain (offline LAN cluster, online VPS cluster)

Location = a tenant / shard you want to operate (Miami1, etc.)

Brand = sub-tenant within a location (brasao, etc.)

Netab “DB context” = (app, locationId) (not clusterId)

Tables are scoped by location; brand is a field inside records (indexed)

That keeps:

offline and online both able to represent the same location

routing handled by table policy (write primary offline, archive online)

web clients can be mapped by domain → (location, brand)

Below is your flow rewritten with minimal changes, plus answers to “what about online clusters?”.

1) Core entities/tables you’ll use (generic)
These are just netab tables in a bootstrap scope:

Bootstrap scope (global within a cord cluster)
nodes (node registry)

locations (location registry)

brands (brand registry, tied to a location)

domains (domain → location + brand mapping)

table_policies (where writes go; fallback clusters; retention)

Then per location (your “db”), you store:

menu_items (with brandId field)

menu_sets (optional)

orders (with brandId, etc.)

2) Tablet onboarding (offline cluster)
On app startup (tablet)
// 1) Start embedded node (steng + cord + netab)
startEmbeddedNode({ nodeId: unique_node_id, type: "FireTablet" })

// 2) Register node in bootstrap scope (so it’s visible to others)
register_node(unique_node_id, { type: "FireTablet" })
User chooses: new location vs connect existing
A) New location
if (ui_is_a_new_location) {
  // Create location record (in bootstrap db/scope)
  location = create_location({
    locationName: "loc_name",
    address: "<address>",
    // optional metadata: timezone, currency, etc.
  })
  // locationId is stable identifier (e.g. "Miami1" or generated)

  // Brand selection
  brand = create_or_select_brand(location.id, { brandName: "brasao" })

  // Domain mapping (optional now; used by web clients later)
  // brasao.helenabox.com -> (locationId, brandId)
  upsert_domain({
    domain: "brasao.helenabox.com",
    locationId: location.id,
    brandId: brand.id
  })

  // IMPORTANT: set table policy (what should we do for online clusters?)
  // Answer: policies are per table_name for this location, not per brand.
  set_table_policy({
    app: "pos",
    locationId: location.id,
    tableName: "orders",
    writePrimaryCluster: "offline",           // offline LAN cluster
    readFallbackClusters: ["online"],         // online VPS cluster
    localRetentionHoursByCluster: { offline: 24, online: 720 }
  })

  set_table_policy({
    app: "pos",
    locationId: location.id,
    tableName: "menu_items",
    writePrimaryCluster: "offline",           // or online if you prefer centralized menu management
    readFallbackClusters: ["online"],
    localRetentionHoursByCluster: { offline: 720, online: 720 }
  })

  // Switch client context to the location (NOT cluster_id.brand_id)
  client.setContext({ app: "pos", locationId: location.id })

  // Add menu items (brandId is just a field)
  add_menu_items(brand.id, ...)
}
Key change vs your version:
✅ db_name should be locationId (and app) — not cluster_id.brand_id.
Brand is a field. Cluster is an execution/replication domain.

This prevents pain later when online cluster needs to represent the same location.

B) Existing location
else {
  // list locations in bootstrap scope
  locations = list_locations()

  location = user_select_location(locations)

  client.setContext({ app: "pos", locationId: location.id })

  // list brands for that location
  brand_list = get_brands_for_location(location.id)

  for each brand in brand_list:
     load_menu(location.id, brand.id)
}
“Load menu” (generic)
load_menu(locationId, brandId) {
  return get_objs(
    "menu_items",
    null,
    [
      ["brandId", "==", brandId],
      ["isActive", "==", true]
    ],
    0,
    500
  )
}
3) What about online clusters?
You don’t “set obj prop cluster=<cluster_id>” on brand.

Instead you set table policies for (app, locationId, tableName) that tell netab:

where writes go (offline vs online primary)

where to fallback for pruned history

retention per cluster

Online cluster nodes will:

host the archive copies for many locations

provide web ingress via domains

Offline cluster leader will WAN-sync oplog to online (batched).

So your answer to:

“what should we do for online clusters?”

is:
✅ set table policies + domain mapping, not “bind brand to cluster”.

4) Web client startup (browser)
A web client only knows a URL like brasao.helenabox.com.

So first step is resolve domain → locationId + brandId.

// web client startup
client = createNetabClient({ baseUrl: "<api_portal>", token: anonymousJWT })

register_node(unique_node_id, { type: "WebClient", url: window.location.host })

// Resolve which location+brand this domain belongs to
mapping = resolve_domain(window.location.host)
// mapping = { locationId, brandId }

// Now set context to that location
client.setContext({ app: "pos", locationId: mapping.locationId })

// Load menu for that brand
menu = get_objs("menu_items", null, [
  ["brandId", "==", mapping.brandId],
  ["isActive", "==", true]
], 0, 500)
Note: your web client shouldn’t call get_all_brands_for_cluster(cluster_id) because it doesn’t care about cluster; it cares about its brand (from the domain mapping). You can still fetch brands for UI, but it’s location-based.

5) Minimal API names to support your flow
You can keep your style and just add a few “bootstrap helpers” (still generic tables underneath):

register_node(node_id, props)

create_location(props) / list_locations()

create_brand(locationId, props) / get_brands_for_location(locationId)

resolve_domain(domain) / upsert_domain(mapping)

set_table_policy(app, locationId, tableName, policy)

These can literally be wrappers over add_objs/get_objs/update_objs on tables:

nodes, locations, brands, domains, table_policies

No special database magic required.

6) Why “locationId = db” is the right pivot
A location exists both offline and online.

A cluster is just where code is running.

Policies decide which cluster is primary for each table.

You can add more clusters later without changing data identifiers.

If you want, I can rewrite your pseudocode verbatim into a final canonical version with the exact minimal helper calls (and define each helper in terms of netab primitives), so you can hand it to Codex/Replit as the “bootstrap workflow”.


note that client normally doesn't know location name , but they do know brand name, we need to make sure when they say brasao and its actually second location for brasao then we don't mixup, we also need to think about security , we cannot show the client other brands&locations, only if our guy does installation it should be possible, so workflow should be clean and secure even if a client do self onboarding


so if the tablet is not registered then we should probably do the following :

1) provide 3 options : choose by Brand , Location id, QR code
   * if added by QR code then it is secure and should connect right away
   * if by Brand name then we should provide list of locations to choose from
   * once location is identified we need to verify that user have rights to connect to it
 
  the authorization should be mostly part of the POS app, however we should also have 
  level of security to make sure the user have permissions to access corresponding app/brand/other tables

lets make sure that each project has also its own docs, tests, playground and deploy as well as high level

additionally we need to add a folder for "app helpers" , for now lets plan to have 
POS "helper" which will simplify work with the database , 
so the UI developer will have very simple APIs to work with menus etc without understanding all complexity
of connecting and working with the data layer

to summarize , make sure that most projects provide authorization in most APIs
and also provide pseudo code for POS helpers and API exposed by it to POS UI developer

Thought for a few seconds
Got it. This is the right direction: secure onboarding + brand ambiguity + least-privilege visibility, with the POS UI developer seeing a very simple helper API.

Below is a concrete plan that ties together:

brand ≠ location (brasao can exist in multiple locations)

3 onboarding options (Brand / Location ID / QR)

security at netab + app-level POS rules

updated repo structure: each project has its own docs/tests/playground/deploy

new app_helpers/pos with pseudocode + UI-facing API

1) Identity model that avoids “brasao” mixups
Canonical IDs
locationId: stable, unique (e.g. loc_01J... or Miami1)

brandId: stable within a location (e.g. brand_brasao), but brasao name can repeat across locations

siteId (optional but recommended): the pairing {locationId, brandId} as a single id used in QR / domain mapping

Why siteId helps:
When user only knows “brasao”, you must pick which brasao (location). siteId removes ambiguity.

2) Security + visibility rules (important)
You want:

random customer cannot list other locations/brands

installer/admin can

self-onboarding is safe

So we must enforce visibility at the data layer, not only in UI.

Token types (JWT)
anonymous: customer session; only allowed to access siteId resolved from domain/QR

installer/admin: can enumerate locations/brands

staff: scoped to a single site/location (kitchen/cashier)

Visibility rule (simple and safe)
Every request carries a scope in JWT:

app = "pos"

either siteId or locationId (prefer siteId)

groups/roles

Then netab enforces:

If token is anonymous: can only read menu + create orders for that siteId

If token is staff: can read/write allowed tables for that site

Only installer/admin tokens can list locations/brands globally

Key point: get_objs("brands", ...) must never return all brands unless token has permission.

3) Onboarding workflow for an unregistered tablet (3 options)
Option A: QR code (best, secure, no browsing)
QR payload should include a signed token or a one-time join code.

Recommended QR payload
{
  "v": 1,
  "joinCode": "J-ABCD-....",        // random, short-ish
  "api": "http://10.0.0.1",         // optional offline router IP
  "siteHint": "site_01J..."          // optional
}
Flow:

tablet scans QR

calls redeem_join_code(joinCode) → returns JWT scoped to site

tablet is connected immediately and securely

No brand/location enumeration required.

Option B: Location ID
User enters locationId (or scans it from a printed label).
Then tablet calls:

request_location_access(locationId)
Server returns either:

“allowed” + token, or

“needs installer approval”, or

“enter PIN/code”

This is secure because locationId alone doesn’t grant access.

Option C: Brand name
User types brasao. Tablet must NOT see all brasao locations unless allowed.

Secure way:

If installer/admin token: allow searching brandName -> list of locations

If not admin: require an additional secret:

a short “location claim code” printed at the location, or

phone/SMS/email verification, or

“approval queue” for installer

So “brand lookup” is not fully open-ended for anonymous.

Brand selection flow (secure)
user enters brand name

tablet calls brand_lookup_request(brandName)

if token lacks rights:

backend returns: “provide join code or location id”

if admin token:

backend returns list of matching sites: {siteId, locationDisplayName}

4) Where authorization lives (by project)
You asked: “most projects provide authorization in most APIs.”

Here’s the split that keeps things clean:

steng (storage engine)
No auth (pure local data engine)

It’s a library that trusts caller (cord/netab) to enforce policy.

cord (cluster coordinator)
Auth only for network RPC (node↔node):

node-to-node authentication (shared cluster key / mTLS later)

prevents random devices spoofing heartbeats/leases/replication

Not user-facing auth.

netab (network tables)
Primary enforcement point for user tokens:

verifies JWT

enforces RBAC visibility per table

enforces “site/location scope”

Exposes user-facing APIs (get/add/update/subscribe etc.), so it must enforce.

app_helpers/pos
Adds app-level rules (POS semantics), but should rely on netab for baseline enforcement.

E.g., customer cannot write orders.status even if they try; netab RBAC blocks.

5) New repo layout (each project has its own docs/tests/playground/deploy)
Top-level still exists:

docs/                 (system-wide docs)
tests/                (system-wide integration tests)
playground/           (system-wide demos)
deploy/               (system-wide deployment layouts)
src/
  steng/
    docs/ tests/ playground/ deploy/
  cord/
    docs/ tests/ playground/ deploy/
  netab/
    docs/ tests/ playground/ deploy/
  app_helpers/
    pos/
      docs/ tests/ playground/
Each project’s docs/README.md should include:

folder map

public interfaces

invariants and threat model (for netab/cord)

6) netab public APIs (with auth baked in)
All user-facing calls require ctx resolved from JWT:

{app, siteId/locationId, roles}

Netab public surface (still generic)
netab.get_objs(table_name, ids, filter, start_pos, max_count)
netab.add_objs(table_name, rows)
netab.update_objs(table_name, ids, patches)
netab.replace_objs(table_name, ids, values)
netab.delete_objs(table_name, ids)
netab.subscribe_objs(table_name, filter, cb, opts)
Plus minimal auth/onboarding endpoints (still generic “access” layer)
netab.auth.anonymous()                        // for browser sessions
netab.auth.login_pin(pin)                    // staff/installer

// onboarding helpers (security-critical)
netab.access.redeem_join_code(joinCode)      // returns scoped JWT
netab.access.request_location_access(locationId, proof?) // returns scoped JWT or challenge
netab.access.lookup_brand(brandName)         // admin only
netab.access.list_sites_for_brand(brandName) // admin only
netab.access.resolve_domain(hostname)        // returns siteId, public
These “access.*” functions are not POS-specific. They are your generic onboarding/identity layer for any app.

7) POS helper layer (app_helpers/pos)
This is what your UI developer uses so they don’t think about netab/cord/steng complexity.

POSHelper: UI-facing API (simple)
interface PosHelper {
  // Bootstrapping / connection
  init(): Promise<void>                                 // starts embedded node, loads cached context if any
  onboarding_options(): { byQR:true, byBrand:true, byLocationId:true }

  connect_by_qr(qrPayload: any): Promise<ConnectedCtx>
  connect_by_location_id(locationId: string, proof?: any): Promise<ConnectedCtx>
  connect_by_brand_name(brandName: string): Promise<{ choices: SiteChoice[] } | { requiresAdminOrJoinCode: true }>
  connect_select_site(siteId: string): Promise<ConnectedCtx>

  // Menu
  menu_list(brandId?: string): Promise<MenuItem[]>
  menu_upsert(item: MenuItem): Promise<void>            // staff/admin only
  menu_set_availability(itemId: string, isActive: boolean): Promise<void>

  // Orders (minimal set)
  order_create(draft: OrderDraft): Promise<{orderId:string}>
  order_list(filter?: any): Promise<Order[]>
  order_subscribe(cb: (evt)=>void): Unsub

  // Context
  get_context(): ConnectedCtx
  set_context(ctx: ConnectedCtx): Promise<void>
}
ConnectedCtx (what POS UI stores)
type ConnectedCtx = {
  app: "pos"
  siteId: string
  locationId: string
  brandId: string
  apiBaseUrl: string     // usually router or localhost
  token: string          // JWT
}
POSHelper internals (how it uses netab)
It calls only netab’s generic get_objs/add_objs/... plus access.* onboarding endpoints.

It stores context locally so next startup auto-connects.

8) POS onboarding pseudocode using helper (what UI dev writes)
Tablet first run
const pos = new PosHelper()

await pos.init()

if (!pos.get_context()) {
  // show 3 options UI: QR / Brand / LocationId

  if (ui.qr_scanned) {
    await pos.connect_by_qr(ui.qr_payload)
  } else if (ui.location_entered) {
    await pos.connect_by_location_id(ui.locationId, ui.proof)
  } else if (ui.brand_entered) {
    const r = await pos.connect_by_brand_name(ui.brandName)
    if (r.requiresAdminOrJoinCode) show("Need join code / installer")
    else {
      const choice = user_pick(r.choices)        // list of site choices
      await pos.connect_select_site(choice.siteId)
    }
  }
}

// now connected
const menu = await pos.menu_list()
renderMenu(menu)
Behind the scenes: connect_by_qr
async function connect_by_qr(qr) {
  const token = await netab.access.redeem_join_code(qr.joinCode)
  const site = await netab.access.resolve_token_site(token) // or resolve_domain/site
  await pos.set_context({ ...site, token })
}
Load menu (generic netab calls)
async function menu_list(brandId = ctx.brandId) {
  return netab.get_objs("menu_items", null, [
    ["brandId","==", brandId],
    ["isActive","==", true]
  ], 0, 500)
}
9) How to prevent client from seeing other brands/locations
Two mechanisms:

Access APIs don’t enumerate without admin
lookup_brand requires installer/admin token.

Data APIs are scoped
JWT contains siteId. netab automatically adds siteId == token.siteId constraint (or denies access to tables not scoped to that site).

So even if a client tries:

get_objs("brands", null, null, 0, 9999)
netab returns only the one allowed brand/site or denies entirely.

10) Next step I can do immediately
If you want, I can regenerate the archive structure with:

src/steng, src/cord, src/netab, src/app_helpers/pos

each with docs/ tests/ playground/ deploy/

and add the POS helper pseudocode files:

pos_helper.ts (interface + internal logic)

onboarding.ts (QR/brand/location flows)

menu.ts, orders.ts

plus a playground “fake UI” script that exercises onboarding + menu load.

Just say “generate the new archive” and I’ll produce it.




