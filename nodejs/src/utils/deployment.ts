import * as yaml from 'js-yaml';
import { getTokenDetails } from '@utils/index';
import { NetworkType } from '@config/index';
import {
  AttributesManifest,
  getServiceParams,
  ICL,
  manifestExpose,
  Service,
  ServiceManifest,
  serviceResourceEndpoints,
} from './manifest-utils';
import { compressOrderSpec } from './spec';
import { contractAddresses } from '@contracts/addresses';
import { OrderDetails } from '@modules/order/types';

enum Tier {
  One,
  Two,
  Three,
  Four,
  Five,
  Six,
  Seven,
}

const validTiers: { [x: string]: Tier[] } = {
  secured1: [Tier.One],
  secured2: [Tier.Two],
  secured3: [Tier.Three],
  community1: [Tier.Four],
  community2: [Tier.Five],
  community3: [Tier.Six],
  community4: [Tier.Seven],
  secured: [Tier.One, Tier.Two, Tier.Three],
  community: [Tier.Four, Tier.Five, Tier.Six, Tier.Seven],
  'community-default': [Tier.One, Tier.Two, Tier.Three, Tier.Four, Tier.Five, Tier.Six, Tier.Seven],
};

const getTierKey = (inputTiers: number[]): string | undefined => {
  for (const key in validTiers) {
    const tiers = validTiers[key];
    if (
      tiers.length === inputTiers.length &&
      tiers.every((tier, index) => tier === inputTiers[index])
    ) {
      return key;
    } else {
      return 'community';
    }
  }
  return undefined;
};

const convertTimeToNumber = (timeStr: string): number => {
  // Retrieve the number and the unit from the timeStr
  const numStr = timeStr.replace(/[^\d]/g, '');
  const unit = timeStr.replace(/\d/g, '');

  // Convert number string to an integer
  const num = parseInt(numStr, 10);
  if (isNaN(num)) {
    console.error('Error converting number');
    return 0;
  }

  // Calculate the total units based on the time unit
  switch (unit) {
    case 'min':
      return num * 60 * 0.5;
    case 'h':
      return num * 60 * 60 * 0.5;
    case 'd':
      return num * 24 * 60 * 60 * 0.5;
    case 'mon':
      // Assuming a month as 30 days
      return num * 30 * 24 * 60 * 60 * 0.5;
    case 'y':
      // Assuming a year as 365 days
      return num * 365 * 24 * 60 * 60 * 0.5;
    default:
      console.error('Unsupported time unit:', unit);
      return 0;
  }
};

const getTimeInMaxUnits = (timeInSeconds: number): string => {
  if (timeInSeconds <= 0) return '0s';

  const units = [
    { unit: 'd', value: 86400 },
    { unit: 'h', value: 3600 },
    { unit: 'min', value: 60 },
    { unit: 's', value: 1 },
  ];

  for (const { unit, value } of units) {
    if (timeInSeconds >= value) {
      return `${Math.floor(timeInSeconds / value)}${unit}`;
    }
  }

  return '0s';
};

const convertSize = (storage: string): number => {
  const value = Number(storage.substring(0, storage.length - 2));
  const unit = storage.substring(storage.length - 2, storage.length);

  switch (unit) {
    case 'Mi':
      return value * 1024 * 1024;
    case 'Gi':
      return value * 1024 * 1024 * 1024;
    case 'Ti':
      return value * 1024 * 1024 * 1024 * 1024;
    default:
      return value;
  }
};

const convertToMaxPricePerBlock = (token: string, tokenPrice: number) => {
  // Define the number of blocks per day (0.5 blocks per second)
  const blocksPerDay = 1800;
  tokenPrice *= 10 ** 18;
  const maxPricePerBlock = Math.round(tokenPrice / blocksPerDay);
  return maxPricePerBlock;
};

interface GPUModel {
  model: string;
}

interface GPUAttributes {
  vendor: {
    [key: string]: GPUModel[];
  };
  req_vram?: string;
}

interface GPUInput {
  attributes: GPUAttributes;
  units: number;
}

interface ConvertedAttribute {
  Key: string;
  Value: string;
}

interface ConvertedGPU {
  Attributes: ConvertedAttribute[];
  Units: number;
}

const convertCpuAttributes = (cpu: {
  units: number;
  attributes?: { arch?: { [key: string]: Array<{ model: string }> } };
}): ConvertedAttribute[] => {
  const attributes: ConvertedAttribute[] = [];

  if (cpu.attributes?.arch) {
    for (const arch in cpu.attributes.arch) {
      cpu.attributes.arch[arch].forEach((item) => {
        const model = item.model;
        const key = `arch/${arch}/model/${model}`;
        attributes.push({
          Key: key,
          Value: 'true',
        });
      });
    }
  }

  return attributes;
};

const convertGpuAttributes = (gpu: GPUInput): ConvertedGPU => {
  const attributes: ConvertedAttribute[] = [];

  for (const vendor in gpu.attributes.vendor) {
    gpu.attributes.vendor[vendor].forEach((item) => {
      const model = item.model;
      const key = `vendor/${vendor}/model/${model}`;
      attributes.push({
        Key: key,
        Value: 'true',
      });
    });
  }

  if (gpu.attributes?.req_vram) {
    attributes.push({
      Key: 'req_vram',
      Value: gpu.attributes.req_vram,
    });
  }

  return {
    Attributes: attributes,
    Units: gpu.units,
  };
};

const convertStorageAttributes = (
  storageAttributes: Record<string, any> | undefined
): ConvertedAttribute[] => {
  if (!storageAttributes) return [];

  const pairs = Object.keys(storageAttributes).map((key) => ({
    Key: key,
    Value: storageAttributes[key].toString(),
  }));

  if (storageAttributes.class === 'ram' && !('persistent' in storageAttributes)) {
    pairs.push({ Key: 'persistent', Value: 'false' });
  }

  pairs.sort((a, b) => a.Key.localeCompare(b.Key));

  return pairs;
};

interface Pricing {
  amount: number;
  token?: string;
  denom?: string;
}

interface Placement {
  pricing: Record<string, Pricing>;
  attributes?: {
    region?: string;
    region_exclude?: string;
    desired_fizz?: string;
    desired_provider?: string;
    cpu_model?: string;
    bandwidth?: string;
    provider_exclude?: string;
    fizz_exclude?: string;
    req_vram?: string;
  };
}

interface ComputeProfile {
  resources: {
    cpu: { units: number };
    memory: { size: string };
    storage:
      | { size: string; attributes?: Record<string, any> }
      | { size: string; attributes?: Record<string, any> }[];
    gpu?: GPUInput;
  };
}

interface Profile {
  placement: Record<string, Placement>;
  compute: Record<string, ComputeProfile>;
  duration: string;
  mode?: string;
  tier?: string;
}

interface IclYaml {
  profiles: Profile;
  services: Record<string, Service>;
  deployment: Record<string, Record<string, { count?: number }>>;
  version: string;
}

interface IclYamlV2 {
  version: string;
  services: Record<
    string,
    {
      image: string;
      pull_policy?: string;
      replica?: number;
      command?: string[];
      args?: string[];
      env?: string[];
      credentials?: {
        host: string;
        username: string;
        password: string;
        email?: string;
      };
      port_policy?: Array<{
        port: number;
        as: number;
        to?: Array<{
          global?: boolean;
        }>;
        service?: string;
      }>;
      resources: {
        cpu: {
          units: number;
          attributes?: {
            arch?: {
              [key: string]: Array<{
                model: string;
              }>;
            };
          };
        };
        memory: {
          size: string;
        };
        storage: Array<{
          name?: string;
          size: string;
          mount?: string;
          readOnly?: boolean;
          attributes?: {
            persistent?: boolean;
            class?: string;
          };
        }>;
        gpu?: {
          units: number;
          attributes: {
            vendor: {
              [key: string]: Array<{
                model: string;
              }>;
            };
          };
        };
      };
      price: {
        token: string;
        amount: number;
      };
    }
  >;
  deployment: {
    duration: string;
    mode: string;
    tiers: string[];
    attributes?: {
      desired_provider?: string;
      desired_fizz?: string;
      provider_exclude?: string;
      fizz_exclude?: string;
      region?: string;
      region_exclude?: string;
      req_vram?: string;
      bandwidth?: string;
      download_speed?: string;
      upload_speed?: string;
    };
  };
}

export const yamlToOrderDetails = (
  yamlString: string,
  networkType: NetworkType
): { error: boolean; orderDetails?: OrderDetails; message?: string } => {
  try {
    const icl = yaml.load(yamlString) as IclYaml | IclYamlV2;

    // Check if this is version 2 format
    if (Number(icl.version) === 2) {
      return convertV2YamlToOrderDetails(icl as IclYamlV2, networkType);
    }

    // Handle version 1 format
    const iclV1 = icl as IclYaml;
    let maxPrice = 0;
    let denom: string = '';
    const profiles = iclV1.profiles || {};
    const services = iclV1.services || {};
    const placements = profiles.placement || {};
    const firstPlacementKey = Object.keys(placements)[0];
    const firstPlacement = placements[firstPlacementKey];

    if (firstPlacement?.pricing && Object.keys(firstPlacement.pricing).length > 0) {
      if (
        Object.keys(firstPlacement.pricing).some((key) => {
          const amount = firstPlacement.pricing?.[key]?.amount;
          return amount === undefined || isNaN(amount);
        })
      ) {
        throw new Error('Please set a valid amount');
      }
      maxPrice = Object.keys(firstPlacement.pricing).reduce((acc, curr) => {
        denom =
          denom ||
          firstPlacement.pricing?.[curr]?.token ||
          firstPlacement.pricing?.[curr]?.denom ||
          '';
        const maxPricePerHours = convertToMaxPricePerBlock(
          denom,
          Number(firstPlacement.pricing?.[curr].amount)
        );
        return acc + (maxPricePerHours as number);
      }, 0);
    }

    const parsedResource = Object.keys(profiles.compute || {}).map((computeProfile, index) => {
      const obj = profiles.compute?.[computeProfile];
      if (!obj) return null;

      let replicaCount = 1;

      for (const key of Object.keys(firstPlacement || {})) {
        const count = (iclV1.deployment as Record<string, Record<string, { count?: number }>>)?.[
          computeProfile
        ]?.[key]?.count;
        if (count !== undefined) {
          replicaCount = count;
          break;
        }
      }

      return {
        Name: computeProfile,
        Resources: {
          ID: index + 1,
          CPU: {
            Units: obj.resources?.cpu ? Math.round(obj.resources.cpu.units * 1000) : 0,
            Attributes: [],
          },
          Memory: {
            Units: obj.resources?.memory ? convertSize(obj.resources.memory.size) : 0,
            Attributes: [],
          },
          Storage: Array.isArray(obj.resources?.storage)
            ? obj.resources.storage.map((storage) => ({
                Name: 'default',
                Attributes: storage.attributes ? convertStorageAttributes(storage.attributes) : [],
                Units: convertSize(storage.size),
              }))
            : obj.resources?.storage
            ? [
                {
                  Name: 'default',
                  Attributes: obj.resources.storage.attributes
                    ? convertStorageAttributes(obj.resources.storage.attributes)
                    : [],
                  Units: convertSize(obj.resources.storage.size),
                },
              ]
            : [],
          GPU:
            obj.resources?.gpu && Object.keys(obj.resources.gpu).length > 0
              ? convertGpuAttributes(obj.resources.gpu)
              : {
                  Units: 0,
                  Attributes: [],
                },
          Endpoints:
            serviceResourceEndpoints(services[computeProfile], iclV1 as ICL)?.map((item) => ({
              Kind: item.kind,
              SequenceNumber: item.sequence_number,
            })) || [],
        },
        ReplicaCount: replicaCount,
      };
    });

    const attributes = [
      {
        Key: 'cpu_model',
        Value: firstPlacement?.attributes?.cpu_model || 'any',
      },
      {
        Key: 'bandwidth',
        Value: firstPlacement?.attributes?.bandwidth || 'any',
      },
    ];

    if (firstPlacement?.attributes?.region) {
      attributes.push({
        Key: 'region',
        Value: firstPlacement.attributes.region,
      });
    }

    if (firstPlacement?.attributes?.region_exclude) {
      attributes.push({
        Key: 'region_exclude',
        Value: firstPlacement.attributes.region_exclude,
      });
    }

    if (firstPlacement?.attributes?.desired_fizz) {
      attributes.push({
        Key: 'desired_fizz',
        Value: firstPlacement.attributes.desired_fizz,
      });
    }

    if (firstPlacement?.attributes?.desired_provider) {
      attributes.push({
        Key: 'desired_provider',
        Value: firstPlacement.attributes.desired_provider,
      });
    }

    if (firstPlacement?.attributes?.provider_exclude) {
      attributes.push({
        Key: 'provider_exclude',
        Value: firstPlacement.attributes.provider_exclude,
      });
    }

    if (firstPlacement?.attributes?.fizz_exclude) {
      attributes.push({
        Key: 'fizz_exclude',
        Value: firstPlacement.attributes.fizz_exclude,
      });
    }

    const placementsRequirement = attributes.length > 0 ? { Attributes: attributes } : {};

    const specNew = {
      Name: firstPlacementKey,
      PlacementsRequirement: placementsRequirement,
      Services: parsedResource,
    };
    const compressedSpec = compressOrderSpec(specNew);

    const orderDetails = {
      maxPrice: typeof maxPrice === 'number' ? BigInt(maxPrice) : BigInt(0),
      numOfBlocks: BigInt(convertTimeToNumber(profiles.duration || '1h')), // > 24 hours = 4 * 86400
      token:
        getTokenDetails(denom, networkType as NetworkType)?.address ||
        contractAddresses[networkType].SPON,
      spec: compressedSpec,
      version: BigInt(Number(iclV1.version)),
      mode: profiles.mode === 'fizz' ? 0 : 1, // Make util function for mode
      tier: validTiers[profiles.tier || 'community'] || [
        ...validTiers['secured'],
        ...validTiers['community'],
      ],
    };

    return { error: false, orderDetails };
  } catch (error) {
    return {
      error: true,
      message: (error as Error)?.message || 'Error parsing YAML',
    };
  }
};

export const getKeysByTierValues = (tierValues: Tier[]): string[] => {
  const resultKeys: string[] = [];

  for (const [key, tiers] of Object.entries(validTiers)) {
    if (tierValues.every((tier) => tiers.includes(tier))) {
      resultKeys.push(key);
    }
  }

  return resultKeys;
};

export const getKeysForTiersString = (tiersString: string): string[] => {
  const tiersArray = tiersString.split(',').map((tier) => {
    switch (tier.trim()) {
      case '0':
        return Tier.One;
      case '1':
        return Tier.Two;
      case '2':
        return Tier.Three;
      case '3':
        return Tier.Four;
      case '4':
        return Tier.Five;
      case '5':
        return Tier.Six;
      case '6':
        return Tier.Seven;
      default:
        throw new Error(`Invalid tier value: ${tier}`);
    }
  });

  return getKeysByTierValues(tiersArray);
};

interface Model {
  model: string;
}

interface Input {
  vendor: Record<string, Model[]>;
}

const convertGpuAttributesIcl = (input: Input): AttributesManifest[] => {
  const output: AttributesManifest[] = [];

  for (const vendor in input.vendor) {
    if (input.vendor.hasOwnProperty(vendor)) {
      input.vendor[vendor].forEach((item) => {
        output.push({
          key: `vendor/${vendor}/model/${item.model}`,
          value: 'true',
        });
      });
    }
  }

  return output;
};

const convertStorageAttrbutesIcl = (
  storageAttributes: Record<string, any>
): AttributesManifest[] => {
  const pairs = Object.keys(storageAttributes).map((key) => ({
    key,
    value: storageAttributes[key].toString(),
  }));

  if (storageAttributes.class === 'ram' && !('persistent' in storageAttributes)) {
    pairs.push({ key: 'persistent', value: 'false' });
  }

  pairs.sort((a, b) => a.key.localeCompare(b.key));

  return pairs;
};

const getStorageAttributesIcl = (
  storage:
    | { size: string; attributes?: Record<string, any> }
    | { size: string; attributes?: Record<string, any> }[]
): AttributesManifest[] | undefined => {
  if (Array.isArray(storage)) {
    return convertStorageAttrbutesIcl(storage[0].attributes || {});
  }
  return storage.attributes ? convertStorageAttrbutesIcl(storage.attributes) : undefined;
};

export const getManifestIcl = (
  yamlInput: string
): { name: string; services: ServiceManifest[] }[] => {
  const input = yaml.load(yamlInput) as IclYaml;

  const placements = input.profiles?.placement;
  const placement = Object.keys(placements)[0];

  return [
    {
      name: placement,
      services: Object.entries(input.services).map(([serviceName, serviceData], index) => {
        const { image, env, command, args, credentials, pull_policy, params } =
          serviceData as Service;
        const { cpu, memory, storage, gpu } = input.profiles.compute[serviceName].resources;
        const count = input.deployment[serviceName][placement].count;

        return {
          name: serviceName,
          image: image,
          command: command,
          args: args,
          env: env,
          credentials,
          pull_policy,
          resources: {
            id: index + 1,
            cpu: {
              units: {
                val: (cpu.units * 1000).toString(), // Convert 0.1 to 100
              },
            },
            memory: {
              size: {
                val: convertSize(memory.size).toString(),
              },
            },
            storage: [
              {
                name: 'default',
                size: {
                  val: Array.isArray(storage)
                    ? convertSize(storage[0].size).toString()
                    : convertSize(storage.size).toString(),
                },
                attributes: getStorageAttributesIcl(storage),
              },
            ],
            gpu: {
              units: {
                val: gpu?.units.toString() || '0',
              },
              attributes: gpu?.attributes ? convertGpuAttributesIcl(gpu?.attributes) : [],
            },
            endpoints: serviceResourceEndpoints(serviceData, input),
          },
          count,
          expose: manifestExpose(serviceData, input),
          params: params ? getServiceParams(params) : null,
        };
      }),
    },
  ];
};

const convertV2YamlToOrderDetails = (
  icl: IclYamlV2,
  networkType: NetworkType
): { error: boolean; orderDetails?: OrderDetails; message?: string } => {
  try {
    let maxPrice = 0;
    let denom: string = '';

    // Calculate max price from services
    const services = icl.services || {};
    Object.values(services).forEach((service) => {
      if (service.price) {
        denom = denom || service.price.token || '';
        const maxPricePerHours = convertToMaxPricePerBlock(denom, service.price.amount);
        maxPrice += maxPricePerHours;
      }
    });

    // Convert services to the expected format
    const parsedResource = Object.keys(services).map((serviceName, index) => {
      const service = services[serviceName];

      return {
        Name: serviceName,
        Resources: {
          ID: index + 1,
          CPU: {
            Units: service.resources?.cpu ? Math.round(service.resources.cpu.units * 1000) : 0,
            Attributes: service.resources?.cpu ? convertCpuAttributes(service.resources.cpu) : [],
          },
          Memory: {
            Units: service.resources?.memory ? convertSize(service.resources.memory.size) : 0,
            Attributes: [],
          },
          Storage: service.resources?.storage
            ? service.resources.storage.map((storage) => ({
                Name: storage.name || 'default',
                ...(storage.attributes ? { Attributes: convertStorageAttributes(storage.attributes) } : {}),
                ...(storage.mount ? { Mount: storage.mount } : {}),
                Units: convertSize(storage.size),
              }))
            : [],
          GPU:
            service.resources?.gpu && service.resources.gpu.units > 0
              ? convertGpuAttributes(service.resources.gpu)
              : {
                  Units: 0,
                  Attributes: [],
                },
        },
        ReplicaCount: service.replica || 1,
      };
    });

    // Build attributes from deployment attributes
    const attributes = [];

    if (icl.deployment?.attributes?.desired_provider) {
      attributes.push({
        Key: 'desired_provider',
        Value: icl.deployment.attributes.desired_provider,
      });
    }
    if (icl.deployment?.attributes?.desired_fizz) {
      attributes.push({
        Key: 'desired_fizz',
        Value: icl.deployment.attributes.desired_fizz,
      });
    }
    if (icl.deployment?.attributes?.provider_exclude) {
      attributes.push({
        Key: 'provider_exclude',
        Value: icl.deployment.attributes.provider_exclude,
      });
    }
    if (icl.deployment?.attributes?.fizz_exclude) {
      attributes.push({
        Key: 'fizz_exclude',
        Value: icl.deployment.attributes.fizz_exclude,
      });
    }
    if (icl.deployment?.attributes?.region) {
      attributes.push({
        Key: 'region',
        Value: icl.deployment.attributes.region,
      });
    }
    if (icl.deployment?.attributes?.region_exclude) {
      attributes.push({
        Key: 'region_exclude',
        Value: icl.deployment.attributes.region_exclude,
      });
    }
    if (icl.deployment?.attributes?.req_vram) {
      attributes.push({
        Key: 'req_vram',
        Value: icl.deployment.attributes.req_vram,
      });
    }
    if (icl.deployment?.attributes?.bandwidth) {
      attributes.push({
        Key: 'bandwidth',
        Value: icl.deployment.attributes.bandwidth,
      });
    }
    if (icl.deployment?.attributes?.download_speed) {
      attributes.push({
        Key: 'download_speed',
        Value: icl.deployment.attributes.download_speed,
      });
    }
    if (icl.deployment?.attributes?.upload_speed) {
      attributes.push({
        Key: 'upload_speed',
        Value: icl.deployment.attributes.upload_speed,
      });
    }

    const placementsRequirement = attributes.length > 0 ? { Attributes: attributes } : {};

    const specNew = {
      PlacementsRequirement: placementsRequirement,
      Services: parsedResource,
    };

    const compressedSpec = compressOrderSpec(specNew);

    const orderDetails = {
      maxPrice: typeof maxPrice === 'number' ? BigInt(maxPrice) : BigInt(0),
      numOfBlocks: BigInt(convertTimeToNumber(icl.deployment?.duration || '1h')),
      token:
        getTokenDetails(denom, networkType as NetworkType)?.address ||
        contractAddresses[networkType].SPON,
      spec: compressedSpec,
      version: BigInt(Number(icl.version)),
      mode: icl.deployment?.mode === 'fizz' ? 0 : 1,
      tier: validTiers[icl.deployment?.tiers?.[0] || 'community-default'] || [
        ...validTiers['secured'],
        ...validTiers['community'],
      ],
    };

    return { error: false, orderDetails };
  } catch (error) {
    return {
      error: true,
      message: (error as Error)?.message || 'Error parsing YAML v2',
    };
  }
};

// New interface for V2 manifest format
export interface V2ServiceManifest {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: string[];
  credentials?: {
    host: string;
    username: string;
    password: string;
    email?: string;
  };
  resources: {
    i: number; // ID
    c: {
      u: number; // CPU units
      a?: Array<{ k: string; v: string }>; // CPU attributes
    };
    m: {
      u: number; // Memory units
    };
    s: Array<{
      n: string; // Name
      u: number; // Units (size)
      a?: Array<{ k: string; v: string }>; // Storage attributes
      m?: string; // Mount path
      ro?: boolean; // Read only
    }>;
    g: {
      u: number; // GPU units
      a?: Array<{ k: string; v: string }>; // GPU attributes
    };
  };
  replica: number;
  ports?: Array<{
    port?: number;
    externalPort?: number;
    global?: boolean;
    exposeTo?: string;
    portRange?: string;
    portRangeAs?: string;
  }>;
  pullPolicy?: string;
}

export interface V2Manifest {
  services: V2ServiceManifest[];
}

export const getManifestV2 = (yamlInput: string): V2Manifest => {
  const icl = yaml.load(yamlInput) as IclYamlV2;

  if (icl.version !== '2.0') {
    throw new Error('This function only supports Version 2 YAML format');
  }

  const services = icl.services || {};

  const manifestServices: V2ServiceManifest[] = Object.keys(services).map((serviceName, index) => {
    const service = services[serviceName];

    // Convert CPU attributes
    const cpuAttributes = service.resources?.cpu?.attributes?.arch
      ? Object.entries(service.resources.cpu.attributes.arch).flatMap(([arch, models]) =>
          models.map((model) => ({
            k: `arch/${arch}/model/${model.model}`,
            v: 'true',
          }))
        )
      : undefined;

    // Convert storage
    const storage =
      service.resources?.storage?.map((storageItem) => {
        const storageAttrs = storageItem.attributes
          ? Object.entries(storageItem.attributes).map(([key, value]) => ({
              k: key,
              v: value.toString(),
            }))
          : undefined;

        const storageObj: any = {
          n: storageItem.name || 'default',
          u: convertSize(storageItem.size),
        };

        // Only include attributes if they exist
        if (storageAttrs && storageAttrs.length > 0) {
          storageObj.a = storageAttrs;
        }

        // Only include mount if it exists
        if (storageItem.mount) {
          storageObj.m = storageItem.mount;
        }

        // Only include readOnly if it exists
        if (storageItem.readOnly !== undefined) {
          storageObj.ro = storageItem.readOnly;
        }

        return storageObj;
      }) || [];

    // Convert GPU attributes
    const gpuAttributes = service.resources?.gpu?.attributes?.vendor
      ? Object.entries(service.resources.gpu.attributes.vendor).flatMap(([vendor, models]) =>
          models.map((model) => ({
            k: `vendor/${vendor}/model/${model.model}`,
            v: 'true',
          }))
        )
      : undefined;

    // Convert port policy to ports
    const ports = service.port_policy?.map((portPolicy) => {
      const port: any = {};

      if (portPolicy.to?.some((to) => to.global)) {
        port.global = true;
      }

      if (portPolicy.port !== undefined) {
        port.port = portPolicy.port;
        port.externalPort = portPolicy.as;
      }

      // Handle service exposure
      if (portPolicy.service) {
        port.exposeTo = portPolicy.service;
      }

      return port;
    });

    const resources: any = {
      i: index + 1,
      c: {
        u: service.resources?.cpu ? Math.round(service.resources.cpu.units * 1000) : 0,
      },
      m: {
        u: service.resources?.memory ? convertSize(service.resources.memory.size) : 0,
      },
      s: storage,
      g: {
        u: service.resources?.gpu?.units || 0,
      },
    };

    // Only include CPU attributes if they exist
    if (cpuAttributes && cpuAttributes.length > 0) {
      resources.c.a = cpuAttributes;
    }

    // Only include GPU attributes if they exist
    if (gpuAttributes && gpuAttributes.length > 0) {
      resources.g.a = gpuAttributes;
    }

    const manifestService: any = {
      name: serviceName,
      image: service.image,
      resources,
      replica: service.replica || 1,
      ports: ports,
      pullPolicy: service.pull_policy,
    };

    // Only include command if it exists
    if (service.command && service.command.length > 0) {
      manifestService.command = service.command;
    }

    // Only include args if it exists
    if (service.args && service.args.length > 0) {
      manifestService.args = service.args;
    }

    // Only include env if it exists
    if (service.env && service.env.length > 0) {
      manifestService.env = service.env;
    }

    // Only include credentials if it exists
    if (service.credentials) {
      manifestService.credentials = service.credentials;
    }

    return manifestService;
  });

  return {
    services: manifestServices,
  };
};
