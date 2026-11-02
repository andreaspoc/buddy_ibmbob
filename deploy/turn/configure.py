"""Configure the authenticated local TURN relay without printing its secret."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
from urllib.parse import urlsplit

parser=argparse.ArgumentParser();parser.add_argument('--relay-ip');parser.add_argument('--listen-ip',action='append',default=[]);args=parser.parse_args()
root=Path(__file__).resolve().parents[2];env=root/'.env';text=env.read_text()
def value(key):
    match=re.search(r'^'+re.escape(key)+r'=(.*)$',text,re.M)
    return match.group(1).strip().strip('\"\'') if match else ''
ip=args.relay_ip or socket.gethostbyname(urlsplit(value('PUBLIC_BASE_URL')).hostname or '')
extra_ips=args.listen_ip or json.loads(value('PEOPLE_TURN_LISTEN_IPS') or '[]')
ips=list(dict.fromkeys([ip,*extra_ips]))
if len(ips)>2:raise SystemExit('This deployment supports one LAN and one VPN listener')
for address in ips:ipaddress.IPv4Address(address)
addresses=subprocess.check_output(['ip','-4','addr','show'],text=True)
if any(not re.search(r'inet '+re.escape(address)+r'/',addresses) for address in ips):raise SystemExit('Supply --relay-ip with a verified local IPv4 address. NAT/public-address mapping requires an explicit deployment configuration.')
key=value('PEOPLE_TURN_SECRET') or secrets.token_urlsafe(48)
if len(key)<32:raise SystemExit('PEOPLE_TURN_SECRET must contain at least 32 characters')
settings={'PEOPLE_TURN_SECRET':key,'PEOPLE_TURN_URLS':json.dumps([f'turn:{address}:3478?transport={transport}' for address in ips for transport in ('udp','tcp')],separators=(',',':')),'PEOPLE_TURN_BIND_IP':ip,'PEOPLE_TURN_LISTEN_IPS':json.dumps(ips,separators=(',',':')),'PEOPLE_TURN_VPN_BIND_IP':ips[1] if len(ips)>1 else ''}
for name,setting in settings.items():
    line=name+'='+setting
    if re.search(r'^'+name+r'=',text,re.M):text=re.sub(r'^'+name+r'=.*$',lambda _:line,text,flags=re.M)
    else:text=text.rstrip()+'\n'+line+'\n'
env.write_text(text);env.chmod(0o600)
directory=root/'.secrets';directory.mkdir(exist_ok=True);directory.chmod(0o700)
for index,address in enumerate(ips):
    configuration=directory/('people-turn.conf' if index==0 else 'people-turn-vpn.conf')
    configuration.write_text(f'''listening-port=3478
listening-ip={address}
relay-ip={address}
min-port=49160
max-port=49200
realm=buddy-people
fingerprint
use-auth-secret
static-auth-secret={key}
no-cli
no-tls
no-dtls
no-tcp-relay
no-multicast-peers
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=0.0.0.0-0.255.255.255
user-quota=4
total-quota=128
max-bps=512000
log-file=stdout
simple-log
pidfile=/tmp/turnserver.pid
''')
    os.chown(configuration,65534,65534);configuration.chmod(0o400)
print('Configured an authenticated People TURN relay on '+', '.join(ips)+'; secrets remain in private configuration files.')
