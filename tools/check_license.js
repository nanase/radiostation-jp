'use strict';

// to run this script: node tools/check_license.js

const fs = require('fs');
const path = require('path');
const execSync = require('child_process').execSync;

function fetchExternalJson(url) {
  const json = execSync(`curl -sS "${url}"`);
  return JSON.parse(json);
}

function parseSpecs(input, reserve) {
  const decodeExp = unit => unit === 'kW' ? 1000 : unit === 'mW' ? 0.001 : 1;
  const { method, freq } = input.match(/(?<method>[A-Z0-9]+)\\t(?:(?<freq>\d+(?:\.\d+)?)\s*MHz?)/).groups;

  if (input.match(/MHz/g).length === 1) {
    // 「最大」の文字が入らない免許状が存在する
    // また、「方向別実効ふく射電力」の文言がない免許状が存在する
    const tpoText = input.match(/(?:(?:\d+(?:\.\d+)?\s*[km]?W)\\n \\t \\t)+(最大)?実効輻射電力/)[0];
    const erpText = input.match(/(?:(?:\d+(?:\.\d+)?\s*[km]?W)(:?\\n)?(?: \\t \\t )?)+(方向別実効ふく射電力)?$/)[0];

    const tpos = [...tpoText.matchAll(/(?<value>\d+(?:\.\d+)?)\s*(?<unit>[km]?W)/g)]
      .map(m => m.groups)
      .map(tpo => Number(tpo.value) * decodeExp(tpo.unit));
    const erps = [...erpText.matchAll(/(?<value>\d+(?:\.\d+)?)\s*(?<unit>[km]?W)/g)]
      .map(m => m.groups)
      .map(erp => Number(erp.value) * decodeExp(erp.unit));

    // TPOとERPの数が一致しない場合は、多いものに合わせて考える
    // どちらかが2個の場合は、前者が親局、後者が予備局である
    if (tpos.length === 1) {
      return { method, freq: freq * 1e6, tpo: tpos[0], erp: erps[reserve ? 1 : 0] };
    } else  if (erps.length === 1) {
      return { method, freq: freq * 1e6, tpo: tpos[reserve ? 1 : 0], erp: erps[0] };
    } else {
      return { method, freq: freq * 1e6, tpo: tpos[reserve ? 1 : 0], erp: erps[reserve ? 1 : 0] };
    }
  } else {
    // ひとつの免許状に親局と予備局が個別かつ同一の周波数について書かれていることがある
    // その場合は個々にパースを行って、予備局の可否によって判断する
    const specs = input.split('方向別実効ふく射電力').filter(Boolean);
    const spec0 = parseSpecs(specs[0], false);
    const spec1 = parseSpecs(specs[1], false);

    // 親局の電力 ＞ 予備局の電力
    if (reserve) {
      return spec0.erp > spec1.erp ? spec1 : spec0;
    } else {
      return spec0.erp > spec1.erp ? spec0 : spec1;
    }
  }
}

async function checkRadioSpec(data) {
  const prefectures =
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '../schema/stations.schema.json')))
      .properties.addresses.additionalProperties.properties.address.properties.prefecture.enum;

  for (const radioStation of data.radioStations) {
    console.info(`${radioStation.nickname}`);

    for (const station of radioStation.stations) {
      const lisenceUrl = station.citations.find(uri => uri.startsWith('https://www.tele.soumu.go.jp/musen'));
      const address = data.addresses[station.addressId];

      // 出典の項目に無線局免許状のURLが存在しない
      if (!lisenceUrl) {
        warn(`${radioStation.nickname}/${station.addressId} has not lisence URL.`);
        continue;
      }

      // 送信局のアドレスが定義されてない
      if (!address) {
        warn(`${radioStation.nickname}/${station.addressId} is used, but not defined.`);
        continue;
      }

      const region = new URL(lisenceUrl).searchParams.get('IT');
      const mhz = (station.frequency / 1e6).toFixed(1);
      const prefectureNumber = prefectures.findIndex(p => p === address.address.prefecture) + 1
      const params = {
        ST: '1',
        DA: '1',
        DC: '1',
        SC: '1',
        OF: '2',
        OW: 'BC',
        MK: 'BBC',
        KHS: radioStation.attributes?.some(a => a === 'foreignLanguage') ? 'FFM' : 'BFM',
        IT: region,
        HZ: '2',
        FF: mhz,
        TF: mhz,
        HCV: (prefectureNumber < 10 ? '0' : '') + (prefectureNumber * 1000),
      };
      const query = new URLSearchParams(params);
      const url = `https://www.tele.soumu.go.jp/musen/list?${query}`;

      // 直接fetchできないので curl で取得する
      const fetchedLicenses = fetchExternalJson(url);

      // fetchの結果、該当する免許状が存在しない
      // 大抵の場合、以下の理由のどれかである:
      //   - URLを間違えている
      //   - コミュニティ放送、外国語放送のフラグミス
      //   - 免許更新、もしくは廃局
      if (!fetchedLicenses.musen) {
        warn(`${radioStation.nickname}/${station.addressId}: spec is not found. ${url}`);
        continue;
      }

      const locationCity = address.address.prefecture + address.address.city;
      const licenses = fetchedLicenses.musen.filter(l =>
        station.type !== 'reserve' && (l.listInfo.tdfkCd === locationCity || l.detailInfo.radioEuipmentLocation.indexOf('送信所') !== -1 && l.detailInfo.radioEuipmentLocation.indexOf(locationCity)) ||
        l.detailInfo.radioEuipmentLocation.indexOf('予備送信所') !== -1 && l.detailInfo.radioEuipmentLocation.indexOf(locationCity));

      // 免許状に記載の住所と一致する送信局が存在しない
      if (licenses.length === 0) {
        warn(`${radioStation.nickname}/${station.addressId}: spec is not found. wrong address?: local=${locationCity} ${url}`);
        continue;
      }

      const specs = licenses.map(l => parseSpecs(l.detailInfo.radioSpec1, station.type === 'reserve'));
      const matchedSpec = specs.filter(spec => spec.freq === station.frequency && spec.tpo === station.tpo && spec.erp === station.erp);

      if (matchedSpec.length === 0) {
        const spec = specs[0];

        if (spec.freq !== station.frequency) {
          warn(`${radioStation.nickname}/${station.addressId}: mismatched frequency: local=${station.frequency / 1e6}, spec=${specspec.freq / 1e6} ${url}`);
        }

        if (spec.tpo !== station.tpo) {
          warn(`${radioStation.nickname}/${station.addressId}: mismatched TPO: local=${station.tpo}, spec=${spec.tpo} ${url}`);
        }

        if (spec.erp !== station.erp) {
          warn(`${radioStation.nickname}/${station.addressId}: mismatched ERP: local=${station.erp}, spec=${spec.erp} ${url}`);
        }
      }
    }
  }
}

function warn(message) {
  console.warn(`\x1b[33m${message}\x1b[0m`);
}

(async function doCheck() {
  const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../stations.json')));

  await checkRadioSpec(data);
})();
