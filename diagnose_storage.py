"""Read the bot's storage status without starting Discord or importing its DB."""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request


KNOWN_ERRORS = {
    '웹 워크스페이스에 Discord 서버 ID를 먼저 등록하세요.':
        '웹 워크스페이스의 Discord 서버 연결에서 이 서버 ID를 등록하세요.',
    '로컬 개발 서버는 localhost로만 접근할 수 있습니다.':
        '웹 서비스의 NODE_ENV를 production으로 설정하고 웹을 재배포하세요.',
    '허용되지 않은 Origin입니다.':
        '웹의 Origin 검사 또는 프록시 설정을 확인하세요.',
    '봇 인증에 실패했습니다.':
        '봇과 웹의 LEARNINGOPS_PROVISION_TOKEN을 맞추세요. 키 값은 공유하지 마세요.',
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def diagnose(env=None, opener=None, guild_id=None):
    env = os.environ if env is None else env
    endpoint = env.get('LEARNINGOPS_PROVISION_URL', '').strip()
    guild_id = str(guild_id or '').strip()
    token = env.get('LEARNINGOPS_PROVISION_TOKEN', '').strip()
    try:
        parsed = urllib.parse.urlsplit(endpoint)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.path != '/api/integrations/discord/provision'):
            raise ValueError
    except ValueError:
        print('LEARNINGOPS_PROVISION_URL을 실제 웹의 HTTPS 주소 + /api/integrations/discord/provision으로 설정하세요.')
        return 2
    if not re.fullmatch(r'[0-9]{17,20}', guild_id):
        print('--guild-id에 점검할 Discord 서버 ID 17~20자리를 입력하세요. 봇 환경변수로 고정할 필요가 없습니다.')
        return 2
    print('WEB_ORIGIN=' + urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', '')))
    print('GUILD_ID=' + guild_id)
    if len(token) < 32:
        print('LEARNINGOPS_PROVISION_TOKEN이 없거나 32자 미만입니다.')
        return 2
    url = endpoint.rsplit('/', 1)[0] + '/storage/status'
    request = urllib.request.Request(url, data=json.dumps({'guildId': guild_id}).encode(),
                                     headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    opener = opener or urllib.request.build_opener(NoRedirect())
    try:
        try:
            response = opener.open(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.code
            print('HTTP_STATUS=' + str(status))
            try:
                body = json.loads(response.read(8192))
            except (ValueError, UnicodeError):
                body = {}
            if not isinstance(body, dict):
                body = {}
            # Never print an arbitrary response or exception: proxies can echo credentials.
            reason = body.get('error')
            if isinstance(reason, str) and reason in KNOWN_ERRORS:
                print('REASON=' + reason)
                print('ACTION=' + KNOWN_ERRORS[reason])
            elif status == 200 and isinstance(body.get('migrated'), bool):
                print('MIGRATED=' + str(body['migrated']).lower())
                print('웹 저장소 접근이 정상입니다. 봇의 다음 재시도 로그를 확인하세요.')
                return 0
            else:
                print('알려진 저장소 응답이 아닙니다. 실제 웹 주소와 웹 서비스 로그를 확인하세요.')
            return 1
    except (OSError, urllib.error.URLError):
        print('웹 저장소에 연결하지 못했습니다. 실제 웹 주소와 네트워크를 확인하세요.')
        return 1


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--guild-id', required=True, help='점검할 워크스페이스의 Discord 서버 ID')
    raise SystemExit(diagnose(guild_id=parser.parse_args().guild_id))
