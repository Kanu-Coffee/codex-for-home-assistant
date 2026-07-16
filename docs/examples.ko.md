# Codex for Home Assistant 프롬프트 예시

[English](examples.en.md) · [README로 돌아가기](../README.md) · [사용 설명서](../codex_home_assistant/DOCS.md)

아래 문장은 그대로 복사한 뒤 자신의 entity, 생활 패턴과 목표에 맞게 바꿔 사용할 수 있습니다. 처음에는 **조사 → 제안 → 승인 → 작은 변경 → 검증** 순서를 권장합니다.

> [!TIP]
> 한 요청에 “아직 수정하지 마”, “변경 전 diff를 보여 줘”, “승인 뒤 적용해”, “적용 후 fresh 상태를 검증해”를 넣으면 작업 경계가 더 분명해집니다.

## 처음 환경 파악하기

```text
현재 Home Assistant 구성을 읽기 전용으로 감사해 줘.
다음 항목을 표로 정리하되 파일, registry와 기기 상태는 아직 수정하지 마.

1. dashboard와 주요 view
2. automation, script와 scene
3. unavailable/unknown entity
4. 최근 Core/App 오류
5. 중복되거나 이름이 모호한 entity
6. backup과 검증이 필요한 개선 후보
```

## 대시보드

### Bubble Card 모바일 홈

```text
Bubble Card가 이미 설치되어 있는지와 현재 dashboard의 저장 방식을 먼저 확인해 줘.
설치되어 있지 않으면 파일을 바꾸지 말고 필요한 설치 단계와 위험만 설명해 줘.

설치되어 있다면 기존 dashboard를 보존하면서 새 모바일용 view를 설계해 줘.
- 390px 폭의 1열 우선
- 상단: 집 모드, 재실, 날씨
- 중단: 자주 쓰는 조명과 공조
- 하단: 문/창문, 배터리 부족, unavailable 요약
- 한 손 조작과 야간 가독성 고려

먼저 사용할 entity, 카드 구조와 YAML diff만 보여 줘.
내가 승인한 뒤 적용하고 1440x900 및 390x844에서 screenshot,
console warning/error와 실패 network request를 확인해 줘.
```

### 기존 대시보드 다듬기

```text
현재 기본 dashboard를 읽기 전용으로 분석해 줘.
중복 카드, 너무 긴 scroll, 모바일에서 잘리는 요소와
중요 상태가 아래에 묻히는 문제를 찾아 줘.

기존 기능과 entity는 유지하면서 최소 변경안 3개를 우선순위로 제안하고,
아직 dashboard는 수정하지 마.
```

### 태블릿 월패널

```text
주방의 10인치 가로형 태블릿용 dashboard 초안을 설계해 줘.
항상 켜 두는 화면이므로 큰 글자와 명확한 상태 색을 사용하고,
날씨·가족 일정·조명·공조·문/창문 상태를 한 화면에 배치해 줘.

현재 설치된 카드만 사용하고, 필요한 entity가 없으면 대체하지 말고 표시해 줘.
먼저 wireframe과 카드 목록만 보여 줘.
```

## 자동화

### 생활 패턴에서 후보 찾기

```text
우리 집 평일 패턴은 다음과 같아.
- 07:00 기상
- 08:10 외출
- 18:30~19:30 귀가
- 23:30 취침

현재 presence, 조명, 온도, 문, 전력 센서와 기존 자동화를 읽기 전용으로 조사해 줘.
새로 만들 만한 자동화 5개를 효과, trigger, condition, action,
오작동 방지 조건, 필요한 entity와 함께 우선순위로 제안해 줘.
기존 자동화와 겹치면 표시하고 아직 적용하지 마.
```

### 외출 모드

```text
마지막 사람이 집을 나갔을 때 실행할 외출 자동화를 설계해 줘.
현재 사용 가능한 재실 센서와 기기를 먼저 확인하고,
조명/공조 정리, 열린 창문 알림, 보안 상태 확인을 후보로 검토해 줘.

도어록, 경보, 차고문은 자동 조작하지 말고 알림만 제안해 줘.
unknown/unavailable과 짧은 재실 흔들림을 방지할 조건도 포함하고,
먼저 계획과 YAML만 보여 줘.
```

### 야간 조명

```text
밤에 복도 motion이 감지될 때 눈부시지 않은 조명을 켜는 자동화를 만들고 싶어.
현재 조도, motion, 복도 조명 entity와 기존 자동화를 확인해 줘.

23:00~06:00, 낮은 밝기, 일정 시간 후 소등,
수동으로 켠 조명을 임의로 끄지 않는 조건을 포함한 초안을 제안해 줘.
내 승인 전에는 적용하지 마.
```

### 자동화 충돌 찾기

```text
같은 조명이나 공조를 서로 다른 값으로 제어하는 자동화 후보를 찾아 줘.
trigger가 가까운 시간에 겹치는 경우, restart/queued/single mode 영향,
상반된 service call과 수동 조작을 되돌리는 경우를 표로 정리해 줘.
수정은 하지 말고 가장 작은 해결책부터 제안해 줘.
```

## 엔티티와 장치 정리

### 미사용 후보

```text
dashboard, automation, script, scene와 template에서 참조되지 않는 entity 후보를 찾아 줘.
disabled, unavailable, integration 제거 흔적, 이름 중복을 구분하고
각 후보의 device/integration, 마지막으로 확인 가능한 근거와 제거 위험을 표로 보여 줘.

외부 앱이나 음성 비서가 사용할 가능성도 경고하고 registry는 수정하지 마.
```

### 이름 체계 정리

```text
entity와 device 표시 이름을 area별로 분석해 줘.
이름 중복, 방 이름 반복, 한글/영문 혼용, 역할이 드러나지 않는 이름을 찾아
일관된 명명 규칙과 rename 후보를 제안해 줘.

entity_id 변경과 표시 이름 변경의 영향을 구분하고 아직 바꾸지 마.
```

### 배터리·통신 품질

```text
배터리 부족, 장시간 unavailable, 최근 자주 끊기는 것으로 보이는 장치 후보를 정리해 줘.
현재 한 시점의 state만으로 고장이라고 단정하지 말고,
확인 가능한 이력과 integration 로그가 있을 때만 근거로 사용해 줘.
교체, 재페어링, 위치 조정 등 후속 확인 순서를 제안해 줘.
```

## 오류와 유지보수

### 설정 오류

```text
Home Assistant 설정을 읽기 전용으로 진단해 줘.
ha-config-check, 관련 YAML, include 경로와 최근 Core 로그를 확인하고
오류 원인을 증거가 강한 순서로 정리해 줘.

가장 작은 수정 diff와 rollback 방법을 보여 주되 내 승인 전에는 적용하거나 재시작하지 마.
```

### 업데이트 전 점검

```text
Home Assistant 업데이트 전에 현재 상태를 점검해 줘.
pending repair, deprecated 설정, custom integration 경고,
backup 필요 항목과 rollback 계획을 정리해 줘.

업데이트, 재시작, addon 조작은 실행하지 말고 체크리스트만 만들어 줘.
```

### 느린 dashboard

```text
현재 dashboard가 느린 원인을 조사해 줘.
Headless browser로 desktop/mobile의 console과 network 상태를 확인하고,
큰 image, 실패 resource, 과도한 custom card, 반복 template 후보를 정리해 줘.

실제 기기 성능이나 network 속도를 browser 결과만으로 단정하지 말고
검증 가능한 최소 개선부터 제안해 줘.
```

## 기억과 집의 맥락

### 명시적인 별칭·용도 기억

```text
entity light.kitchen_main은 우리 집에서 "준비등"이라고 부르고
아침 식사 준비에 쓰는 조명이야. 이 정보는 앞으로도 유지되니 기억해 줘.
```

### 집 전체 선호 기억

```text
우리 집은 알림을 보낼 때 음성 안내보다 모바일 notification을 우선해.
이건 집 전체에 적용할 지속적인 선호이니 기억해 줘.
```

현재 state, “오늘만”, 추측과 page/log 관측값은 지속 정보로 기억시키지 않는 편이 좋습니다. 정정할 때는 대상과 이전 의미를 명확히 말하세요.

```text
준비등의 용도를 정정할게. 아침 식사 준비가 아니라 야간 간접 조명으로 쓰고 있어.
기존 기억과 충돌하면 덮어쓰지 말고 무엇을 바꿀지 먼저 보여 줘.
```

## 안전이 중요한 작업

다음 예시처럼 조사와 실행을 분리하세요.

```text
현관 도어락 관련 자동화를 읽기 전용으로 감사해 줘.
잠금 해제 service는 절대 호출하지 말고,
trigger, condition, 실패 시 동작과 알림 경로만 검토해 줘.
```

```text
난방 자동화의 현재 설정과 센서 상태를 조사해 줘.
setpoint나 mode를 바꾸지 말고 에너지 절감 후보만 제안해 줘.
실제 변경은 내가 별도로 승인한 한 항목씩 수행해.
```

## 좋은 요청을 만드는 틀

```text
목표:
현재 상황:
반드시 보존할 것:
조사할 범위:
수정 금지 범위:
승인 전 원하는 결과: 계획 / 표 / YAML / diff
승인 후 검증: ha-config-check / fresh API / desktop+mobile browser
rollback 방법:
```

요청이 구체적일수록 결과를 검토하기 쉽습니다. 실제 entity ID, 원하는 시간대와 실패 시 안전한 기본 동작을 알려 주되 token, password, 내부 공개가 곤란한 URL은 넣지 마세요.
