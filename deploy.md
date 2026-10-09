# yt-audio-app Container Deployment

## Local test on Fedora

```bash
chmod +x test-local.sh
./test-local.sh
```

- Open http://localhost:3000
- Data persists in `./podman-data`
- Logs: `podman logs -f yt-audio-app`
- Stop: `podman stop yt-audio-app`

## Push to Oracle Cloud ARM VM

Step 1 — save the image locally:

```bash
podman save -o yt-audio-app.tar yt-audio-app
```

Step 2 — copy to VM (replace `<VM_IP>` and key path):

```bash
scp -i ~/.ssh/oci_key yt-audio-app.tar ubuntu@<VM_IP>:/home/ubuntu/
```

Step 3 — ssh into VM and load:

```bash
ssh -i ~/.ssh/oci_key ubuntu@<VM_IP>
podman load -i yt-audio-app.tar
```

Step 4 — create data dir and run:

```bash
mkdir -p /home/ubuntu/yt-data
podman run -d --name yt-audio-app -p 80:3000 -v /home/ubuntu/yt-data:/app/data:Z --restart unless-stopped yt-audio-app
```

Step 5 — survive logout:

```bash
sudo loginctl enable-linger $USER
```

Step 6 — open ports in OCI Security List AND local firewall:

- OCI Console: VCN → Security Lists → add Ingress TCP 80 from `0.0.0.0/0`
- On VM: `sudo firewall-cmd --permanent --add-port=80/tcp && sudo firewall-cmd --reload` (Oracle Linux) OR use iptables (Ubuntu)

## Updating after code change

```bash
git pull
podman build --platform linux/arm64 -t yt-audio-app .
podman save -o yt-audio-app.tar yt-audio-app
scp -i ~/.ssh/oci_key yt-audio-app.tar ubuntu@<VM_IP>:/home/ubuntu/
ssh -i ~/.ssh/oci_key ubuntu@<VM_IP>
podman stop yt-audio-app && podman rm yt-audio-app
podman load -i yt-audio-app.tar
podman run -d --name yt-audio-app -p 80:3000 -v /home/ubuntu/yt-data:/app/data:Z --restart unless-stopped yt-audio-app
```

Data in the volume survives.

## Troubleshooting

- No audio: `podman exec -it yt-audio-app yt-dlp --version` (should print a version). If empty, rebuild.
- 502 on every track: YouTube is blocking the IP. Add cookies: `podman run ... -e YTDLP_COOKIES=/app/cookies.txt -v /path/to/cookies.txt:/app/cookies.txt:Z ...`
- Login broken: check data/ permissions. The container runs as user `node` (uid 1000). The host volume must be writable by uid 1000: `sudo chown -R 1000:1000 /home/ubuntu/yt-data`
- Container won't start: `podman logs yt-audio-app`
- Port 80 in use on VM: change to `-p 8080:3000`
