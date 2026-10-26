# gameface-css-compat

[English](README.md)

최신 CSS를 [Coherent Gameface](https://coherent-labs.com/products/coherent-gameface/)가 렌더링할 수 있는 형태로 자동 변환합니다. 정확히 같은 결과를 내는 대체 코드가 있으면 그것으로 바꿉니다. 없으면 제거하고(어차피 Gameface가 무시하는 코드입니다) 무엇을 제거했는지 보고합니다.

공식 [`eslint-plugin-gameface`](https://www.npmjs.com/package/eslint-plugin-gameface)는 지원하지 않는 기능을 *알려주기만* 하고, 이 도구는 고칠 수 있는 것을 *고칩니다*. 지원 여부 데이터는 그 플러그인에서 그대로 읽어 오므로 두 도구의 판단은 항상 같습니다.

> 비공식 프로젝트입니다. Coherent Labs와 무관하며 승인받지 않았습니다. "Gameface"는 해당 소유자의 상표입니다. 기능 데이터는 모두 MIT 라이선스인 `eslint-plugin-gameface`에서 가져옵니다.

```css
/* 입력 */
.panel {
  inset-inline: 0;
  padding-block: 8px 12px;
  width: clamp(200px, 40vw, 480px);
  font-weight: 700;
  float: left;
}
.panel:is(.open, .pinned) > .title { text-align: start; }

/* 출력 (gameface 모드) */
.panel {
  left: 0;
  right: 0;
  padding-top: 8px;
  padding-bottom: 12px;
  width: 200px;
  font-weight: bold;
}
@media (min-width: 500px) { .panel { width: 40vw; } }
@media (min-width: 1200px) { .panel { width: 480px; } }
.panel.open > .title, .panel.pinned > .title { text-align: left; }
```

## 여기서 말하는 "100%"

공식 카탈로그에는 Gameface가 지원하지 않거나 일부만 지원하는 항목이 758개 있습니다. gameface 모드에서는 이 항목들이 모두 다음 둘 중 하나로 처리됩니다.

- **변환**: Gameface가 지원하면서 렌더링 결과가 같은 코드로 바꿉니다. 133개이고, 일부만 변환되는 항목이 3개 더 있습니다.
- **제거 후 보고**: 대체할 방법이 없어 삭제합니다. 어차피 Gameface 파서가 버리는 코드입니다. 614개이며 `float`, grid, `:has()`, `@container`, `%`와 `px`를 섞은 `calc()` 등이 여기에 속합니다.

변환이 끝난 출력에는 지원하는 모든 Gameface 버전에서 공식 린터 **에러가 0개**입니다. 항목별 처리 결과는 [docs/coverage.md](docs/coverage.md)에서 볼 수 있습니다. 이 문서는 자동 생성되며 CI에서 최신 상태인지 검사합니다.

이 도구는 추측하지 않습니다. 변환은 도구가 확인할 수 있는 조건에서 정확히 같은 결과일 때만 적용됩니다. 비슷하기만 한 변환은 직접 켜야 하는 [근사 변환](#근사-변환)으로 분리해 두었습니다.

## 두 가지 모드

| | `gameface` (기본값) | `source` |
| --- | --- | --- |
| 용도 | Gameface 전용 빌드 결과물 | 브라우저에서도 보는 소스 파일 |
| 변환 기준 | Gameface 기준으로 정확함 (항상 LTR, screen 미디어) | **모든** 브라우저에서 정확함 |
| 고칠 수 없는 항목 | 제거하고 보고 | 그대로 두고 보고 |
| 린트 결과 | 에러 0개 | 브라우저에서 동일하게 고칠 방법이 없는 것만 남음 |

권장 구성은 에디터와 Stylelint 자동 수정에는 `source`, 빌드(Vite 플러그인)에는 `gameface`를 쓰는 것입니다.

## 설치

```sh
npm i -D gameface-css-compat
```

Node 20.11 이상이 필요합니다. `vite`, `stylelint`, `postcss-scss`는 선택적 peer 의존성이므로 해당 통합 기능을 쓸 때만 설치하면 됩니다.

## 사용법

### Vite (권장)

```js
// vite.config.js
import gamefaceCompat from 'gameface-css-compat/vite';

export default { plugins: [gamefaceCompat()] };
```

`vite build`일 때만, 번들링이 끝난 최종 CSS에 적용됩니다. 따라서 JS에서 import한 CSS나 Vue/Svelte의 `<style>`까지 페이지의 모든 CSS를 보고, 아래의 전체 분석을 활용할 수 있습니다. 결과 보고서는 `gameface-compat-report.json`으로 저장됩니다.

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `version` | `'latest'` | 대상 Gameface 버전 |
| `closedWorld` | `false` | 커스텀 속성을 JS나 인라인 스타일에서 설정하지 않음 |
| `rootFontSize` | `null` | `1rem`이 고정 px 값일 때 그 크기 |
| `approximations` | `[]` | [근사 변환](#근사-변환) 참고 |
| `disable` | `[]` | 건너뛸 transform id |
| `report` | `'gameface-compat-report.json'` | 보고서 파일 이름, 끄려면 `false` |
| `failOnRemoved` | `false` | 제거된 항목이 하나라도 있으면 빌드 실패 |

### Stylelint (에디터, `--fix`)

```js
// stylelint.config.js
export default {
  plugins: ['gameface-css-compat/stylelint'],
  rules: { 'gameface-compat/compat': [true, { assumeLtr: true }] },
};
```

항상 `source` 모드로 동작하므로, 자동 수정한 뒤에도 브라우저 화면은 그대로입니다. 브라우저에서 동일하게 고칠 방법이 없는 항목은 경고로 표시됩니다.

### PostCSS

```js
import gamefaceCompat from 'gameface-css-compat/postcss';
export default { plugins: [gamefaceCompat({ mode: 'gameface', complete: true })] };
```

PostCSS는 파일을 하나씩 처리합니다. `complete: true`는 그 파일이 페이지 CSS의 전부일 때만 지정하세요.

### CLI

```sh
npx gameface-css-compat fix src/            # 소스를 직접 수정 (source 모드)
npx gameface-css-compat check src/          # 바뀔 내용이 있으면 exit 1 (CI용)
npx gameface-css-compat build dist/ -o out/ # Gameface용 결과물 생성 (gameface 모드)
npx gameface-css-compat coverage --json     # 카탈로그 전체 항목의 처리 결과
```

## 전체 분석

어떤 변환은 페이지 전체에 대한 사실을 알아야만 정확해집니다. 도구는 이런 사실을 가정하지 않고 직접 확인합니다.

- **`complete`**: 처리하는 CSS가 페이지 CSS의 전부라는 뜻입니다. Vite 플러그인과 CLI는 자동으로 켭니다. 이 정보가 있으면 "이 변수는 항상 `:root`에 정의된다"(→ `var()` fallback 제거)나 "이 요소의 transform은 애니메이션되지 않는다"(→ `skew(a, b)`를 `matrix()`로 변환) 같은 사실을 확인할 수 있습니다.
- **`closedWorld`**: 커스텀 속성을 CSS에서만 설정한다는 뜻입니다. 이것은 사용자만 알 수 있으므로 직접 켜야 합니다.
- **`rootFontSize`**: `rem`이 포함된 계산(fluid `clamp()` 등)도 접을 수 있게 합니다.

필요한 정보를 알 수 없으면 해당 변환은 적용하지 않고 보고서에 남깁니다.

## 근사 변환

기본값은 모두 꺼짐입니다. `approximations: [...]` 또는 `--approx a,b`로 켭니다.

| id | 동작 | 정확하지 않은 이유 |
| --- | --- | --- |
| `outline-to-box-shadow` | `outline` → `box-shadow` | 기존 그림자와 겹칠 수 있고, 점선 offset을 표현할 수 없음 |
| `flex-start-end-assume-no-reverse` | `start`/`end` → `flex-start`/`flex-end` | `*-reverse` 컨테이너에서는 반대 방향이 됨 |
| `where-to-is` | `:where()`를 `:is()`처럼 펼침 | 명시도(specificity)가 올라감 |
| `font-weight-nearest` | `450` → `normal` 등 | Gameface에는 normal과 bold만 있음 |
| `transform-merge` | 애니메이션 가능성이 있어도 `matrix`로 합침 | 애니메이션 중간 보간이 달라짐 |
| `browser-defaults-preamble` | Chromium식 기본 스타일을 앞에 추가 | Gameface의 UA 스타일시트와 다름 |

## 검증 방식

사람이 변환 결과를 검수하지 않는 것을 전제로, 모든 보장은 자동 검증으로 확보합니다.

1. **공식 린터 × 전체 항목 × 전체 버전**: 카탈로그의 각 항목마다 공식 데이터로 샘플을 만들고, 변환한 뒤 `eslint-plugin-gameface`로 린트합니다. 에러가 0개여야 통과하며, 플러그인이 아는 모든 Gameface 버전에서 반복합니다. 결과를 한 번 더 변환해도 아무것도 바뀌지 않아야 합니다(멱등성).
2. **브라우저 동등성**: `source` 모드의 모든 변환을 Playwright로 Chromium에서 변환 전과 후로 각각 렌더링해, 요소 박스, 계산된 색상과 스타일, 스크린샷 픽셀을 비교합니다. 색상, 계산식, fluid 크기는 무작위 입력으로도 검증합니다.
3. **단위 테스트**: CSS 계산 엔진, Chromium 반올림을 재현한 색상 변환, 각 transform을 검사합니다.

## 자동 업데이트

`.github/workflows/upstream-sync.yml`이 매주 실행됩니다. `eslint-plugin-gameface` 새 버전이 나오면 설치하고, 커버리지 문서를 다시 만들고, 브라우저 테스트를 포함한 전체 테스트를 돌린 뒤, 새로 생기거나 사라지거나 결과가 바뀐 항목을 정리한 PR을 엽니다. 테스트가 모두 통과하면 PR은 자동으로 머지됩니다. 자동 머지를 끄려면 저장소 변수 `AUTO_MERGE_UPSTREAM`을 `false`로 설정하세요.

새로 추가된 미지원 기능은 코드 수정 없이도 데이터 기반 파이프라인이 제거하고 보고합니다. 반대로 Gameface가 지원하게 되어 카탈로그에서 빠진 기능은 해당 버전에서 변환이 자동으로 꺼집니다.

## 한계

- Gameface에는 grid, `float`, `:has()`, `@container`가 없습니다. 무엇으로도 렌더링할 수 없으므로 제거하고 보고합니다. 이런 레이아웃은 flexbox로 다시 만들어야 합니다.
- `%`와 길이를 섞은 `calc()`는 Gameface에서 표현할 수 없습니다. 단, 뷰포트 기반 fluid 계산은 미디어 쿼리로 변환합니다.
- 뷰포트 단위를 쓰는 fluid `clamp()`/`min()`/`max()`는 최상위 규칙이나 `@layer` 안에서만 변환하며(다른 `@media` 안은 제외), 분기점은 최대 12개입니다.
- Gameface는 LTR만 지원합니다. source 모드에서 논리 속성은 `assumeLtr`를 켰을 때만 변환됩니다.
- 데이터의 정확도는 `eslint-plugin-gameface`에 달려 있습니다. 데이터 오류는 업스트림에 제보해 주세요.

## 라이선스

[MIT](LICENSE)
