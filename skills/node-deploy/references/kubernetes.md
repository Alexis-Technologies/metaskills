# Kubernetes, if the platform changes

Fly.io is the default. The same image runs on Kubernetes without code changes, if the app already
follows `node-config` and `node-graceful-shutdown`. What changes is the deploy files.

## Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: auth8-api
spec:
  replicas: 3
  strategy:
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
  minReadySeconds: 10
  selector:
    matchLabels: { app: auth8-api }
  template:
    metadata:
      labels: { app: auth8-api }
    spec:
      terminationGracePeriodSeconds: 40
      securityContext: { runAsNonRoot: true, runAsUser: 1000 }
      containers:
        - name: api
          image: registry.example.com/auth8-api:<git-sha>
          ports: [{ containerPort: 3000 }]
          envFrom:
            - configMapRef: { name: auth8-api }
            - secretRef: { name: auth8-api }
          env:
            - { name: FASTIFY_ADDRESS, value: 0.0.0.0 }
            - { name: FASTIFY_CLOSE_GRACE_DELAY, value: '25000' }
            - { name: NODE_OPTIONS, value: --max-old-space-size=384 }
          resources:
            requests: { cpu: 500m, memory: 512Mi }
            limits: { memory: 512Mi }
          startupProbe:
            httpGet: { path: /health/live, port: 3000 }
            periodSeconds: 2
            failureThreshold: 30
          livenessProbe:
            httpGet: { path: /health/live, port: 3000 }
            periodSeconds: 10
          readinessProbe:
            httpGet: { path: /health/ready, port: 3000 }
            periodSeconds: 5
          lifecycle:
            preStop:
              sleep: { seconds: 5 }
          securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false }
```

## Rules

- **Liveness answers from memory**, readiness may check cached dependency state. A liveness probe
  that checks the database restarts every pod when the database blinks (`node-scaling-highload`).
- **`preStop` sleep** covers endpoint propagation: under `fastify start` the app cannot keep serving
  after it starts closing (`node-graceful-shutdown`). Older clusters without the `sleep` action
  need `exec` of `sleep 5`, which needs `sleep` in the image.
- **`terminationGracePeriodSeconds`** counts from the start of `preStop`: preStop + grace delay +
  margin, here 5 + 25 + 10.
- **Memory limit = request**, and `--max-old-space-size` at about 75% of it. A pod over its limit is
  killed with 137, without a shutdown.
- **No CPU limit** for latency-sensitive services: the quota throttles the event loop in bursts
  and shows as latency spikes. Set a CPU request for scheduling.
- **Scale on the right signal.** CPU works for CPU-bound services. For I/O-bound ones, export event
  loop utilization as a custom metric and scale on it, targeting about 50% (`node-event-loop`).
- **A PodDisruptionBudget** (`minAvailable: 2`) keeps node drains from taking every replica.
- **One process per container**, as on Fly.io: no `cluster`, no PM2.
- **Secrets** come from `Secret` objects or an external secret operator, never from the image or a
  ConfigMap.
